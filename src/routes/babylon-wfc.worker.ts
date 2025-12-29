import { pipeline, type TextGenerationPipeline, type FeatureExtractionPipeline, env } from '@xenova/transformers';

// Model configuration
const MODEL_ID = 'Xenova/qwen1.5-0.5b-chat';
const EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

// CORS proxy services for Hugging Face model loading
const CORS_PROXY_SERVICES = [
  'https://api.allorigins.win/raw?url=',
  'https://corsproxy.io/?',
  'https://api.codetabs.com/v1/proxy?quest=',
] as const;

/**
 * Check if a URL needs CORS proxying
 */
function needsProxy(url: string): boolean {
  return (
    url.includes('huggingface.co') &&
    !url.includes('cdn.jsdelivr.net') &&
    !url.includes('api.allorigins.win') &&
    !url.includes('corsproxy.io') &&
    !url.includes('api.codetabs.com')
  );
}

/**
 * Custom fetch function with CORS proxy support
 */
async function customFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  
  // If URL doesn't need proxying, use normal fetch
  if (!needsProxy(url)) {
    return fetch(input, init);
  }
  
  // Try each CORS proxy in order
  for (const proxyBase of CORS_PROXY_SERVICES) {
    try {
      const proxyUrl = proxyBase + encodeURIComponent(url);
      const response = await fetch(proxyUrl, {
        ...init,
        redirect: 'follow',
      });
      
      // Skip proxies that return error status codes
      if (response.status >= 400 && response.status < 600) {
        continue;
      }
      
      // If response looks good, return it
      if (response.ok) {
        return response;
      }
    } catch {
      // Try next proxy
      continue;
    }
  }
  
  // If all proxies fail, try direct fetch as last resort
  return fetch(input, init);
}

/**
 * Set up custom fetch function for Transformers.js
 */
function setupCustomFetch(): void {
  if (typeof env === 'object' && env !== null) {
    const envRecord: Record<string, unknown> = env;
    envRecord.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      return customFetch(input, init);
    };
  }
}

let embeddingPipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
let textGenerationPipelinePromise: Promise<TextGenerationPipeline> | null = null;

/**
 * Get or create the feature extraction pipeline (singleton pattern)
 */
async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (!embeddingPipelinePromise) {
    env.allowLocalModels = false;
    setupCustomFetch();
    const pipelineResult = await pipeline('feature-extraction', EMBEDDING_MODEL_ID);
    if (pipelineResult !== null && pipelineResult !== undefined) {
      // Pipeline can return a function or an object - both are valid
      // TypeScript can't narrow the pipeline return type, but we know it's FeatureExtractionPipeline
      // from the pipeline('feature-extraction', ...) call
      if (typeof pipelineResult === 'function' || (typeof pipelineResult === 'object' && pipelineResult !== null)) {
        embeddingPipelinePromise = Promise.resolve(pipelineResult as FeatureExtractionPipeline);
      } else {
        throw new Error('Embedding pipeline result is not a function or object');
      }
    } else {
      throw new Error('Embedding pipeline result is null or undefined');
    }
  }
  return embeddingPipelinePromise;
}

/**
 * Get or create the text generation pipeline (singleton pattern)
 */
async function getTextGenerationPipeline(): Promise<TextGenerationPipeline> {
  if (!textGenerationPipelinePromise) {
    env.allowLocalModels = false;
    setupCustomFetch();
    textGenerationPipelinePromise = pipeline('text-generation', MODEL_ID);
  }
  return textGenerationPipelinePromise;
}

/**
 * Extract assistant response from generated text
 */
function extractAssistantResponse(generatedText: string, formattedPrompt: string): string {
  let response = generatedText;
  
  if (response.includes(formattedPrompt)) {
    response = response.replace(formattedPrompt, '');
  }
  
  response = response.replace(/<\|im_start\|>assistant\s*/g, '');
  response = response.replace(/<\|im_end\|>/g, '');
  response = response.replace(/<\|im_start\|>/g, '');
  response = response.replace(/^\s*(user|assistant)[:\s]+/i, '');
  
  const lastAssistantIndex = response.lastIndexOf('assistant');
  if (lastAssistantIndex !== -1) {
    const afterAssistant = response.substring(lastAssistantIndex + 'assistant'.length);
    if (afterAssistant.trim().length > 0) {
      response = afterAssistant;
    }
  }
  
  response = response.replace(/^\s*user[:\s]+/i, '');
  response = response.trim();
  
  return response;
}

// Worker message types using discriminated unions
type LoadEmbeddingMessage = {
  id: string;
  type: 'load-embedding';
};

type LoadTextGenMessage = {
  id: string;
  type: 'load-textgen';
};

type GenerateEmbeddingMessage = {
  id: string;
  type: 'generate-embedding';
  text: string;
};

type GenerateLayoutMessage = {
  id: string;
  type: 'generate-layout';
  prompt: string;
};

// Worker response types using discriminated unions
type LoadedResponse = {
  id: string;
  type: 'loaded';
};

type EmbeddingResultResponse = {
  id: string;
  type: 'embedding-result';
  embedding: number[]; // Float32Array converted to array for transfer
};

type LayoutResultResponse = {
  id: string;
  type: 'layout-result';
  response: string;
};

type ErrorResponse = {
  id: string;
  type: 'error';
  error: string;
};

type WorkerMessage = LoadEmbeddingMessage | LoadTextGenMessage | GenerateEmbeddingMessage | GenerateLayoutMessage;

self.onmessage = async (event: MessageEvent<WorkerMessage>): Promise<void> => {
  const { id, type } = event.data;
  
  try {
    if (type === 'load-embedding') {
      await getEmbeddingPipeline();
      const response: LoadedResponse = { id, type: 'loaded' };
      self.postMessage(response);
    } else if (type === 'load-textgen') {
      await getTextGenerationPipeline();
      const response: LoadedResponse = { id, type: 'loaded' };
      self.postMessage(response);
    } else if (type === 'generate-embedding') {
      const embeddingPipeline = await getEmbeddingPipeline();
      
      const result = await embeddingPipeline(event.data.text, { pooling: 'mean', normalize: true });
      
      if (result && typeof result === 'object' && 'data' in result) {
        const data = result.data;
        if (data instanceof Float32Array) {
          // Convert Float32Array to regular array for transfer
          const embeddingArray = Array.from(data);
          const embeddingResponse: EmbeddingResultResponse = {
            id,
            type: 'embedding-result',
            embedding: embeddingArray,
          };
          self.postMessage(embeddingResponse);
        } else {
          throw new Error('Embedding result data is not a Float32Array');
        }
      } else {
        throw new Error('Invalid embedding result format');
      }
    } else if (type === 'generate-layout') {
      const textGenPipeline = await getTextGenerationPipeline();
      
      // Format prompt using tokenizer
      const tokenizer = textGenPipeline.tokenizer;
      let formattedPrompt: string;
      
      if (tokenizer && typeof tokenizer.apply_chat_template === 'function') {
        const messages = [
          {
            role: 'user',
            content: `Generate a layout description for a hexagonal grid based on this request: "${event.data.prompt}"

You can respond in two ways:

1. JSON format with these fields:
   - buildingDensity: "low" | "medium" | "high"
   - clustering: "random" | "clustered" | "sparse"
   - grassRatio: number between 0 and 1
   - buildingSizeHint: "small" | "medium" | "large"

2. Natural language description that will be parsed.

Respond with only the JSON or description, no additional text.`,
          },
        ];
        
        const prompt = tokenizer.apply_chat_template(messages, {
          tokenize: false,
          add_generation_prompt: true,
        });
        
        if (typeof prompt !== 'string') {
          throw new Error('Chat template did not return a string');
        }
        formattedPrompt = prompt;
      } else {
        formattedPrompt = `User: Generate a layout description for a hexagonal grid based on this request: "${event.data.prompt}"\nAssistant:`;
      }
      
      // Generate response
      const result = await textGenPipeline(formattedPrompt, {
        max_new_tokens: 150,
        temperature: 0.7,
        do_sample: true,
      });
      
      // Extract generated text
      let generatedText = '';
      if (Array.isArray(result) && result.length > 0) {
        const firstItem = result[0];
        if (typeof firstItem === 'object' && firstItem !== null && 'generated_text' in firstItem) {
          const textValue = firstItem.generated_text;
          if (typeof textValue === 'string') {
            generatedText = textValue;
          }
        }
      } else if (typeof result === 'object' && result !== null && 'generated_text' in result) {
        const textValue = result.generated_text;
        if (typeof textValue === 'string') {
          generatedText = textValue;
        }
      }
      
      if (generatedText === '') {
        throw new Error('Failed to extract generated text from result');
      }
      
      // Extract assistant response
      const response = extractAssistantResponse(generatedText, formattedPrompt);
      
      const layoutResponse: LayoutResultResponse = {
        id,
        type: 'layout-result',
        response,
      };
      self.postMessage(layoutResponse);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorResponse: ErrorResponse = {
      id,
      type: 'error',
      error: errorMessage,
    };
    self.postMessage(errorResponse);
  }
};

