import { pipeline, type TextGenerationPipeline, env } from '@xenova/transformers';

// Model configuration
// Using Qwen1.5-0.5B-Chat for multilingual chat (supports the same 8 languages)
// Note: This model is proven to work with Transformers.js and is already used in other endpoints
const MODEL_ID = 'Xenova/qwen1.5-0.5b-chat';

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
  
  if (!needsProxy(url)) {
    return fetch(input, init);
  }
  
  for (const proxyBase of CORS_PROXY_SERVICES) {
    try {
      const proxyUrl = proxyBase + encodeURIComponent(url);
      const response = await fetch(proxyUrl, {
        ...init,
        redirect: 'follow',
      });
      
      if (response.status >= 400 && response.status < 600) {
        continue;
      }
      
      if (response.ok) {
        return response;
      }
    } catch {
      continue;
    }
  }
  
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

/**
 * Get language-specific system prompt
 */
function getLanguagePrompt(language: string): string {
  const languagePrompts: Record<string, string> = {
    en: 'You are a helpful assistant. Respond in English.',
    de: 'Du bist ein hilfreicher Assistent. Antworte auf Deutsch.',
    fr: 'Vous êtes un assistant utile. Répondez en français.',
    it: 'Sei un assistente utile. Rispondi in italiano.',
    pt: 'Você é um assistente útil. Responda em português.',
    hi: 'आप एक सहायक सहायक हैं। हिंदी में उत्तर दें।',
    es: 'Eres un asistente útil. Responde en español.',
    th: 'คุณเป็นผู้ช่วยที่เป็นประโยชน์ ตอบเป็นภาษาไทย',
  };
  
  return languagePrompts[language] || languagePrompts.en;
}

/**
 * Extract assistant response from generated text, removing prompt and formatting
 */
function extractAssistantResponse(generatedText: string, formattedPrompt: string): string {
  let response = generatedText;
  
  if (response.includes(formattedPrompt)) {
    response = response.replace(formattedPrompt, '');
  }
  
  // Remove Qwen/Llama-specific tokens
  response = response.replace(/<\|im_start\|>assistant\s*/g, '');
  response = response.replace(/<\|im_end\|>/g, '');
  response = response.replace(/<\|im_start\|>/g, '');
  response = response.replace(/<\|begin_of_text\|>/g, '');
  response = response.replace(/<\|end_of_text\|>/g, '');
  
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
type LoadMessage = {
  id: string;
  type: 'load';
};

type GenerateMessage = {
  id: string;
  type: 'generate';
  message: string;
  language: string;
  options: {
    max_new_tokens: number;
    temperature: number;
    do_sample: boolean;
  };
};

type WorkerMessage = LoadMessage | GenerateMessage;

// Worker response types using discriminated unions
type LoadedResponse = {
  id: string;
  type: 'loaded';
};

type ResultResponse = {
  id: string;
  type: 'result';
  response: string;
};

type ErrorResponse = {
  id: string;
  type: 'error';
  error: string;
};

self.onmessage = async (event: MessageEvent<WorkerMessage>): Promise<void> => {
  const { id, type } = event.data;
  
  try {
    if (type === 'load') {
      await getPipeline();
      const response: LoadedResponse = { id, type: 'loaded' };
      self.postMessage(response);
    } else if (type === 'generate') {
      const generator = await getPipeline();
      const languagePrompt = getLanguagePrompt(event.data.language);
      
      const tokenizer = generator.tokenizer;
      let formattedPrompt: string;
      
      if (tokenizer && typeof tokenizer.apply_chat_template === 'function') {
        const messages = [
          { role: 'system', content: languagePrompt },
          { role: 'user', content: event.data.message }
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
        formattedPrompt = `${languagePrompt}\n\nUser: ${event.data.message}\nAssistant:`;
      }
      
      const result = await generator(formattedPrompt, event.data.options);
      
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
      
      const response = extractAssistantResponse(generatedText, formattedPrompt);
      
      const resultResponse: ResultResponse = {
        id,
        type: 'result',
        response: response || 'I understand.',
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

