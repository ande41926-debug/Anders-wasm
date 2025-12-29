import { pipeline, type Pipeline, env } from '@xenova/transformers';

// Model configuration
const MODEL_ID = 'Xenova/vit-gpt2-image-captioning';

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

let pipelinePromise: Promise<Pipeline> | null = null;

/**
 * Get or create the image-to-text pipeline (singleton pattern)
 */
async function getPipeline(): Promise<Pipeline> {
  if (!pipelinePromise) {
    env.allowLocalModels = false;
    setupCustomFetch();
    pipelinePromise = pipeline('image-to-text', MODEL_ID);
  }
  return pipelinePromise;
}

// Worker message types using discriminated unions
type LoadMessage = {
  id: string;
  type: 'load';
  progressCallback?: boolean;
};

type GenerateMessage = {
  id: string;
  type: 'generate';
  imageData: string; // Data URL string
};

// Worker response types using discriminated unions
type LoadedResponse = {
  id: string;
  type: 'loaded';
};

type ResultResponse = {
  id: string;
  type: 'result';
  caption: string;
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
      
      // Run inference
      const result: unknown = await generator(event.data.imageData);
      
      // Extract the generated text
      let caption = '';
      
      if (Array.isArray(result) && result.length > 0) {
        const firstResult: unknown = result[0];
        if (typeof firstResult === 'object' && firstResult !== null) {
          if ('generated_text' in firstResult) {
            const generatedText: unknown = firstResult.generated_text;
            if (typeof generatedText === 'string') {
              caption = generatedText;
            }
          }
          if (caption === '' && 'text' in firstResult) {
            const text: unknown = firstResult.text;
            if (typeof text === 'string') {
              caption = text;
            }
          }
        }
      } else if (typeof result === 'object' && result !== null) {
        if ('generated_text' in result) {
          const generatedText: unknown = result.generated_text;
          if (typeof generatedText === 'string') {
            caption = generatedText;
          }
        }
        if (caption === '' && 'text' in result) {
          const text: unknown = result.text;
          if (typeof text === 'string') {
            caption = text;
          }
        }
      }
      
      const resultResponse: ResultResponse = {
        id,
        type: 'result',
        caption: caption || 'No caption generated',
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

