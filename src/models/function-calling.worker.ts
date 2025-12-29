import { pipeline, type TextGenerationPipeline, env } from '@xenova/transformers';

// Model configuration
const MODEL_ID = 'Xenova/distilgpt2';

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

let pipelinePromise: Promise<TextGenerationPipeline> | null = null;

/**
 * Get or create the text generation pipeline (singleton pattern)
 */
async function getPipeline(): Promise<TextGenerationPipeline> {
  if (!pipelinePromise) {
    env.allowLocalModels = false;
    setupCustomFetch();
    pipelinePromise = pipeline('text-generation', MODEL_ID);
  }
  return pipelinePromise;
}

// Worker message types using discriminated unions
type LoadMessage = {
  id: string;
  type: 'load';
};

type GenerateMessage = {
  id: string;
  type: 'generate';
  prompt: string;
  options: {
    max_new_tokens: number;
    temperature: number;
    do_sample: boolean;
    top_p?: number;
    repetition_penalty?: number;
  };
};

// Worker response types using discriminated unions
type LoadedResponse = {
  id: string;
  type: 'loaded';
};

type ResultResponse = {
  id: string;
  type: 'result';
  generatedText: string;
};

type ErrorResponse = {
  id: string;
  type: 'error';
  error: string;
};

type WorkerMessage = LoadMessage | GenerateMessage;

self.onmessage = async (event: MessageEvent<WorkerMessage>): Promise<void> => {
  const { id, type } = event.data;
  
  try {
    if (type === 'load') {
      await getPipeline();
      const response: LoadedResponse = { id, type: 'loaded' };
      self.postMessage(response);
    } else if (type === 'generate') {
      const generator = await getPipeline();
      
      // Generate response
      const result = await generator(event.data.prompt, event.data.options);
      
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
      
      const resultResponse: ResultResponse = {
        id,
        type: 'result',
        generatedText,
      };
      self.postMessage(resultResponse);
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

