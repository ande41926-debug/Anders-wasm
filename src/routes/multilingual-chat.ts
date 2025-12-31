import type { WasmModuleMultilingualChat, TextStats } from '../types';
import { loadWasmModule, validateWasmModule } from '../wasm/loader';

// Lazy WASM import - only load when init() is called
let wasmModuleExports: {
  default: () => Promise<unknown>;
  detect_language: (text: string) => string;
  get_text_stats: (text: string) => string;
  normalize_text: (text: string, language: string) => string;
} | null = null;

const getInitWasm = async (): Promise<unknown> => {
  if (!wasmModuleExports) {
    const module = await import('../../pkg/wasm_multilingual_chat/wasm_multilingual_chat.js');
    
    if (typeof module !== 'object' || module === null) {
      throw new Error('Imported module is not an object');
    }
    
    const moduleKeys = Object.keys(module);
    
    const requiredExports = [
      'detect_language',
      'get_text_stats',
      'normalize_text',
    ];
    
    const getProperty = (obj: object, key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(obj, key);
      return descriptor ? descriptor.value : undefined;
    };
    
    for (const exportName of requiredExports) {
      const exportValue = getProperty(module, exportName);
      if (!exportValue || typeof exportValue !== 'function') {
        throw new Error(`Module missing or invalid '${exportName}' export. Available: ${moduleKeys.join(', ')}`);
      }
    }
    
    if (!('default' in module) || typeof module.default !== 'function') {
      throw new Error(`Module missing 'default' export. Available: ${moduleKeys.join(', ')}`);
    }
    
    // Extract and assign functions - we've validated they exist and are functions above
    // TypeScript can't narrow the dynamic import type, so we need assertions after validation
    wasmModuleExports = {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      default: getProperty(module, 'default') as () => Promise<unknown>,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      detect_language: getProperty(module, 'detect_language') as (text: string) => string,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      get_text_stats: getProperty(module, 'get_text_stats') as (text: string) => string,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      normalize_text: getProperty(module, 'normalize_text') as (text: string, language: string) => string,
    };
  }
  if (!wasmModuleExports) {
    throw new Error('Failed to load WASM module exports');
  }
  return wasmModuleExports.default();
};

let wasmModule: WasmModuleMultilingualChat | null = null;
let chatWorker: Worker | null = null;
let chatContainerEl: HTMLElement | null = null;

// Logging function - accessible to all functions
let addLogEntry: ((message: string, type?: 'info' | 'success' | 'warning' | 'error') => void) | null = null;

function validateMultilingualChatModule(exports: unknown): WasmModuleMultilingualChat | null {
  if (!validateWasmModule(exports)) {
    return null;
  }
  
  if (typeof exports !== 'object' || exports === null) {
    return null;
  }
  
  const getProperty = (obj: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    return descriptor ? descriptor.value : undefined;
  };
  
  const exportKeys = Object.keys(exports);
  const missingExports: string[] = [];
  
  const memoryValue = getProperty(exports, 'memory');
  if (!memoryValue || !(memoryValue instanceof WebAssembly.Memory)) {
    missingExports.push('memory (WebAssembly.Memory)');
  }
  
  if (!wasmModuleExports) {
    missingExports.push('module exports (wasmModuleExports is null)');
  } else {
    const requiredFunctions = [
      'detect_language',
      'get_text_stats',
      'normalize_text',
    ];
    
    for (const funcName of requiredFunctions) {
      const funcValue = getProperty(wasmModuleExports, funcName);
      if (!funcValue || typeof funcValue !== 'function') {
        missingExports.push(`${funcName} (function)`);
      }
    }
  }
  
  if (missingExports.length > 0) {
    throw new Error(`WASM module missing required exports: ${missingExports.join(', ')}. Available exports from init result: ${exportKeys.join(', ')}`);
  }
  
  const memory = memoryValue;
  if (!(memory instanceof WebAssembly.Memory)) {
    return null;
  }
  
  if (!wasmModuleExports) {
    return null;
  }
  
  return {
    memory,
    detect_language: wasmModuleExports.detect_language,
    get_text_stats: wasmModuleExports.get_text_stats,
    normalize_text: wasmModuleExports.normalize_text,
  };
}

// Language options
const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt', name: 'Português' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'es', name: 'Español' },
  { code: 'th', name: 'ไทย' },
] as const;

/**
 * Detect language and get statistics for a message
 */
function detectAndAnalyzeMessage(text: string): { language: string; stats: TextStats | null } {
  if (!wasmModule) {
    return { language: 'en', stats: null };
  }
  
  const detectedLanguage = wasmModule.detect_language(text);
  const statsJson = wasmModule.get_text_stats(text);
  
  let stats: TextStats | null = null;
  try {
    const parsed = JSON.parse(statsJson);
    if (typeof parsed === 'object' && parsed !== null) {
      if (
        typeof parsed.wordCount === 'number' &&
        typeof parsed.characterCount === 'number' &&
        typeof parsed.characterCountNoSpaces === 'number' &&
        typeof parsed.sentenceCount === 'number' &&
        typeof parsed.averageWordLength === 'number'
      ) {
        stats = {
          wordCount: parsed.wordCount,
          characterCount: parsed.characterCount,
          characterCountNoSpaces: parsed.characterCountNoSpaces,
          sentenceCount: parsed.sentenceCount,
          averageWordLength: parsed.averageWordLength,
        };
      }
    }
  } catch {
    // Invalid JSON, stats will remain null
  }
  
  return { language: detectedLanguage, stats };
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

type WorkerResponse = LoadedResponse | ResultResponse | ErrorResponse;

/**
 * Generate chat response using Web Worker
 */
async function generateChatResponse(message: string, language: string): Promise<string> {
  if (!chatWorker) {
    throw new Error('Chat worker not initialized');
  }
  
  const worker = chatWorker;
  
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    
    const handler = (event: MessageEvent<WorkerResponse>): void => {
      if (event.data.id !== id) {
        return;
      }
      
      worker.removeEventListener('message', handler);
      
      if (event.data.type === 'result') {
        resolve(event.data.response);
      } else if (event.data.type === 'error') {
        reject(new Error(event.data.error));
      }
    };
    
    worker.addEventListener('message', handler);
    
    const generateMessage: GenerateMessage = {
      id,
      type: 'generate',
      message,
      language,
      options: {
        max_new_tokens: 150,
        temperature: 0.7,
        do_sample: true,
      },
    };
    
    worker.postMessage(generateMessage);
  });
}

/**
 * Add message to chat
 */
function addChatMessage(text: string, detectedLanguage: string, stats: TextStats | null, isUser: boolean): void {
  const chatMessagesEl = document.getElementById('chatMessages');
  if (!chatMessagesEl) {
    return;
  }
  
  const messageDiv = document.createElement('div');
  messageDiv.className = `chat-message ${isUser ? 'user' : 'assistant'}`;
  
  const textDiv = document.createElement('div');
  textDiv.textContent = text;
  messageDiv.appendChild(textDiv);
  
  if (isUser && stats) {
    const infoDiv = document.createElement('div');
    infoDiv.className = 'message-info';
    infoDiv.textContent = `Detected: ${detectedLanguage.toUpperCase()} | Words: ${stats.wordCount} | Chars: ${stats.characterCount}`;
    messageDiv.appendChild(infoDiv);
  }
  
  chatMessagesEl.appendChild(messageDiv);
  scrollToBottom();
}

/**
 * Scroll chat to bottom
 */
function scrollToBottom(): void {
  const chatMessagesEl = document.getElementById('chatMessages');
  if (chatMessagesEl) {
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }
}

/**
 * Show thinking animation on chat container
 */
async function showThinkingAnimation(): Promise<void> {
  if (chatContainerEl) {
    chatContainerEl.classList.add('thinking');
    void chatContainerEl.offsetHeight;
    
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
    
    if (addLogEntry) {
      const timestamp = new Date().toLocaleString();
      addLogEntry(`[${timestamp}] Started thinking`, 'info');
    }
  }
}

/**
 * Hide thinking animation on chat container
 */
function hideThinkingAnimation(): void {
  if (chatContainerEl) {
    chatContainerEl.classList.remove('thinking');
    if (addLogEntry) {
      const timestamp = new Date().toLocaleString();
      addLogEntry(`[${timestamp}] Finished thinking`, 'info');
    }
  }
}

/**
 * Load chat model in Web Worker
 */
async function loadChatModel(): Promise<void> {
  if (chatWorker) {
    return;
  }
  
  if (addLogEntry) {
    addLogEntry('Loading chat model in worker...', 'info');
  }
  
  chatWorker = new Worker(
    new URL('./multilingual-chat.worker.ts', import.meta.url),
    { type: 'module' }
  );
  
  await new Promise<void>((resolve, reject) => {
    if (!chatWorker) {
      reject(new Error('Failed to create worker'));
      return;
    }
    
    const worker = chatWorker;
    const id = crypto.randomUUID();
    
    const handler = (event: MessageEvent<WorkerResponse>): void => {
      if (event.data.id !== id) {
        return;
      }
      
      worker.removeEventListener('message', handler);
      
      if (event.data.type === 'loaded') {
        resolve();
      } else if (event.data.type === 'error') {
        reject(new Error(event.data.error));
      }
    };
    
    worker.addEventListener('message', handler);
    
    const loadMessage: LoadMessage = { id, type: 'load' };
    worker.postMessage(loadMessage);
  });
  
  if (addLogEntry) {
    addLogEntry('Chat model loaded successfully', 'success');
  }
}

export async function init(): Promise<void> {
  const errorEl = document.getElementById('error');
  const loadingIndicatorEl = document.getElementById('loadingIndicator');
  const checkmarkWasmEl = document.getElementById('checkmark-wasm');
  const checkmarkModelEl = document.getElementById('checkmark-model');
  const systemLogsContentEl = document.getElementById('systemLogsContent');
  const chatInputEl = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const chatMessagesEl = document.getElementById('chatMessages');
  chatContainerEl = document.getElementById('chatContainer');

  if (!errorEl || !loadingIndicatorEl || !checkmarkWasmEl || !checkmarkModelEl || !systemLogsContentEl) {
    throw new Error('Required UI elements not found');
  }

  if (!chatInputEl || !sendBtn || !chatMessagesEl || !chatContainerEl) {
    throw new Error('Chat UI elements not found');
  }

  // Setup logging
  addLogEntry = (message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void => {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = document.createElement('div');
    logEntry.className = `log-entry ${type}`;
    logEntry.textContent = `[${timestamp}] ${message}`;
    systemLogsContentEl.appendChild(logEntry);
    systemLogsContentEl.scrollTop = systemLogsContentEl.scrollHeight;
  };


  // Show loading indicator
  loadingIndicatorEl.style.display = 'block';

  try {
    // Load WASM module
    addLogEntry('Initializing WASM language detection module...', 'info');
    wasmModule = await loadWasmModule<WasmModuleMultilingualChat>(
      getInitWasm,
      validateMultilingualChatModule
    );
    addLogEntry('WASM module loaded successfully', 'success');
    checkmarkWasmEl.classList.add('visible');
    loadingIndicatorEl.style.display = 'none';

    // Load chat model
    await loadChatModel();
    checkmarkModelEl.classList.add('visible');

    // Setup chat input handler
    const handleSend = async (): Promise<void> => {
      if (!(chatInputEl instanceof HTMLInputElement)) {
        return;
      }
      const message = chatInputEl.value.trim();
      if (!message) {
        return;
      }

      // Clear input
      chatInputEl.value = '';
      sendBtn.setAttribute('disabled', 'true');

      // Detect language and get stats
      const { language: detectedLanguage, stats } = detectAndAnalyzeMessage(message);
      
      // Add user message
      addChatMessage(message, detectedLanguage, stats, true);

      // Show thinking animation
      await showThinkingAnimation();

      try {
        if (addLogEntry) {
          const languageName = LANGUAGES.find(l => l.code === detectedLanguage)?.name || detectedLanguage.toUpperCase();
          addLogEntry(`Generating response in ${languageName} (detected from input)...`, 'info');
        }
        const response = await generateChatResponse(message, detectedLanguage);
        hideThinkingAnimation();
        addChatMessage(response, '', null, false);
        if (addLogEntry) {
          addLogEntry('Chat response generated', 'success');
        }
      } catch (error) {
        hideThinkingAnimation();
        throw error;
      } finally {
        sendBtn.removeAttribute('disabled');
      }
    };

    sendBtn.addEventListener('click', () => {
      handleSend().catch((error) => {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (errorEl) {
          errorEl.textContent = `Error: ${errorMessage}`;
        }
        if (addLogEntry) {
          addLogEntry(`Error: ${errorMessage}`, 'error');
        }
      });
    });

    chatInputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const handleSendFn = handleSend;
        handleSendFn().catch((error) => {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          if (errorEl) {
            errorEl.textContent = `Error: ${errorMessage}`;
          }
          if (addLogEntry) {
            addLogEntry(`Error: ${errorMessage}`, 'error');
          }
        });
      }
    });

    // Cleanup worker on page unload
    window.addEventListener('beforeunload', () => {
      if (chatWorker) {
        chatWorker.terminate();
      }
    });

  } catch (error) {
    loadingIndicatorEl.style.display = 'none';
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errorEl.textContent = `Error: ${errorMessage}`;
    if (addLogEntry) {
      addLogEntry(`Failed to initialize: ${errorMessage}`, 'error');
    }
    throw error;
  }
}

