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

type WorkerResponse = LoadedResponse | ResultResponse | ErrorResponse;

// Worker instance
let functionCallingWorker: Worker | null = null;

// Loading state
let isLoading = false;
let isLoaded = false;

// Progress callback type
export type ProgressCallback = (progress: number) => void;
export type LogCallback = (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
export type ClarificationCallback = (text: string, availableOperations: readonly string[]) => Promise<string>;

/**
 * Function call result type
 */
export type FunctionCallResult = 
  | { type: 'function_call'; function: string; arguments: string; result: string }
  | { type: 'response'; text: string }
  | { type: 'error'; message: string };

/**
 * Agent step result
 */
export interface AgentStep {
  step: number;
  llmOutput: string;
  functionCall: { function: string; arguments: string } | null;
  functionResult: string | null;
  finalResponse: string | null;
}

/**
 * Load the DistilGPT-2 text generation model in Web Worker
 */
export async function loadAgentModel(
  onProgress?: ProgressCallback,
  onLog?: LogCallback
): Promise<void> {
  if (isLoaded && functionCallingWorker) {
    if (onLog) {
      onLog('Agent model already loaded', 'info');
    }
    return;
  }

  if (isLoading) {
    if (onLog) {
      onLog('Agent model is already loading...', 'info');
    }
    return;
  }

  isLoading = true;

  try {
    if (onLog) {
      onLog('Loading agent model in worker...', 'info');
    }

    if (onProgress) {
      onProgress(0.1);
    }

    functionCallingWorker = new Worker(
      new URL('./function-calling.worker.ts', import.meta.url),
      { type: 'module' }
    );

    // Wait for worker to load model
    await new Promise<void>((resolve, reject) => {
      if (!functionCallingWorker) {
        reject(new Error('Failed to create worker'));
        return;
      }

      const worker = functionCallingWorker;
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

    if (onProgress) {
      onProgress(1.0);
    }

    isLoaded = true;
    isLoading = false;

    if (onLog) {
      onLog('Agent model loaded successfully', 'success');
    }
  } catch (error) {
    isLoading = false;
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    if (onLog) {
      onLog(`Failed to load agent model: ${errorMsg}`, 'error');
    }
    throw new Error(`Failed to load agent model: ${errorMsg}`);
  }
}

/**
 * Parse function call from LLM output
 * Looks for patterns like: [FUNCTION: calculate(expression="...")]
 * or JSON format: {"function": "calculate", "arguments": {"expression": "..."}}
 */
function parseFunctionCall(output: string): { function: string; arguments: string } | null {
  // Try JSON format first
  try {
    const jsonMatch = output.match(/\{[\s\S]*"function"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        // Use Object.entries for type-safe access without assertions
        const entries: Array<[string, unknown]> = Object.entries(parsed);
        const funcNameEntry = entries.find(([key]) => key === 'function');
        const argsEntry = entries.find(([key]) => key === 'arguments');
        const funcName = funcNameEntry && typeof funcNameEntry[1] === 'string' ? funcNameEntry[1] : null;
        const args = argsEntry ? argsEntry[1] : null;
        if (funcName && args) {
          return {
            function: funcName,
            arguments: typeof args === 'string' ? args : JSON.stringify(args),
          };
        }
      }
    }
  } catch {
    // Not JSON, try other formats - ignore parse errors
  }

  // Try [FUNCTION: name(args)] format
  const functionMatch = output.match(/\[FUNCTION:\s*(\w+)\s*\(([^)]*)\)\]/);
  if (functionMatch) {
    return {
      function: functionMatch[1],
      arguments: functionMatch[2],
    };
  }

  // Try function name followed by arguments
  const simpleMatch = output.match(/(?:call|use|execute)\s+(\w+)\s*\(([^)]*)\)/i);
  if (simpleMatch) {
    return {
      function: simpleMatch[1],
      arguments: simpleMatch[2],
    };
  }

  return null;
}

/**
 * Extract function arguments from string
 * Handles formats like: expression="..." or {"expression": "..."}
 */
function extractFunctionArguments(argsString: string): Record<string, string> {
  const result: Record<string, string> = {};
  
  // Try JSON format
  try {
    const parsed: unknown = JSON.parse(argsString);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      // Use Object.entries for type-safe access without assertions
      for (const [key, value] of Object.entries(parsed)) {
        result[key] = String(value);
      }
      return result;
    }
  } catch {
    // Not JSON, parse key=value format
  }

  // Parse key="value" or key=value format
  const keyValueRegex = /(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*([^\s,)]+)/g;
  let match;
  while ((match = keyValueRegex.exec(argsString)) !== null) {
    const key = match[1] || match[3];
    const value = match[2] || match[4];
    if (key) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Execute a tool function via WASM
 */
export type ExecuteToolFunction = (functionName: string, args: Record<string, string>) => Promise<string>;

/**
 * Run agent with function calling
 * Returns array of steps showing agent's reasoning and function calls
 */
export async function runAgent(
  goal: string,
  executeTool: ExecuteToolFunction,
  onLog?: LogCallback,
  maxIterations = 5,
  onClarify?: ClarificationCallback
): Promise<AgentStep[]> {
  if (!functionCallingWorker) {
    throw new Error('Agent model not loaded');
  }

  const steps: AgentStep[] = [];
  // GPT-2 style prompt (no chat template needed)
  // DistilGPT-2 has a 1024 token context window
  // Use goal-specific prompt without hardcoded examples that get copied
  const isMathGoal = /\d+\s*[+\-*/]\s*\d+/.test(goal);
  const isArrayGoal = /^\[[\d\s,]+\]$/.test(goal.trim());
  
  // Store text goal variables for direct execution
  let textToProcess: string | null = null;
  let inferredOperation: string | null = null;
  let hasInferredTextOperation = false;
  
  // Store array data for direct execution
  let arrayData: string | null = null;
  
  let conversationHistory: string;
  if (isMathGoal) {
    // For math goals, directly instruct to use calculate with the goal expression
    const mathExpression = goal.replace(/What is\s+/i, '').replace(/\s*\?/g, '').trim();
    conversationHistory = `Goal: ${goal}\n\nStep 1: Call calculate(expression="${mathExpression}")\nStep 2: Output the result as the final answer.\n\n`;
  } else if (isArrayGoal) {
    // For array goals, use get_stats with the array data
    arrayData = goal.trim();
    conversationHistory = `Goal: ${goal}\n\nStep 1: Call get_stats(data="${arrayData}")\nStep 2: Output the result as the final answer.\n\n`;
  } else {
    // For text goals, extract quoted text and infer operation from goal
    const textContent = goal.trim();
    
    // Try to extract quoted text from goal (e.g., "UPPERCASE" from 'Give me "UPPERCASE" in lowercase')
    const quotedMatch = textContent.match(/"([^"]+)"/);
    textToProcess = quotedMatch ? quotedMatch[1] : textContent;
    
    // Infer operation from goal keywords
    const goalLower = goal.toLowerCase();
    let operation = '';
    if (goalLower.includes('lowercase') || goalLower.includes('lower case')) {
      operation = 'lowercase';
    } else if (goalLower.includes('uppercase') || goalLower.includes('upper case')) {
      operation = 'uppercase';
    } else if (goalLower.includes('reverse')) {
      operation = 'reverse';
    } else if (goalLower.includes('length') || goalLower.includes('how long')) {
      operation = 'length';
    } else if (goalLower.includes('word count') || goalLower.includes('words')) {
      operation = 'word_count';
    }
    
    if (operation) {
      inferredOperation = operation;
      hasInferredTextOperation = true;
      conversationHistory = `Goal: ${goal}\n\nStep 1: Call process_text(text="${textToProcess}",operation="${inferredOperation}")\nStep 2: Output the result as the final answer.\n\n`;
    } else {
      // Human in the loop: request clarification for operation
      const availableOperations = ['uppercase', 'lowercase', 'reverse', 'length', 'word_count'] as const;
      if (onClarify) {
        if (onLog) {
          onLog(`Operation could not be inferred from goal. Requesting user clarification.`, 'info');
        }
        const selectedOperation = await onClarify(textToProcess, availableOperations);
        if (onLog) {
          onLog(`Using user-selected operation: ${selectedOperation}`, 'success');
        }
        inferredOperation = selectedOperation;
        hasInferredTextOperation = true;
        conversationHistory = `Goal: ${goal}\n\nStep 1: Call process_text(text="${textToProcess}",operation="${inferredOperation}")\nStep 2: Output the result as the final answer.\n\n`;
      } else {
        // Fallback: let model choose (less reliable)
        if (onLog) {
          onLog(`No clarification callback provided. Letting model choose operation.`, 'warning');
        }
        conversationHistory = `Goal: ${goal}\n\nUse process_text function. Available operations: uppercase, lowercase, reverse, length, word_count\nCall process_text with text="${textToProcess}" and choose appropriate operation.\n\n`;
      }
    }
  }

  // Limit conversation history length to avoid tokenizer issues
  // DistilGPT-2 context is 1024 tokens, but we need room for generation
  // Rough estimate: 1 token ≈ 4 characters, so 1000 chars ≈ 250 tokens
  const maxHistoryLength = 1000;

  for (let step = 1; step <= maxIterations; step++) {
    if (onLog) {
      onLog(`Agent step ${step}/${maxIterations}`, 'info');
    }

    // For array goals, directly execute get_stats on step 1
    if (isArrayGoal && step === 1 && arrayData !== null) {
      if (onLog) {
        onLog(`Directly executing get_stats for array: ${arrayData}`, 'info');
      }
      
      // Directly execute the function call
      const functionResult = await executeTool('get_stats', {
        data: arrayData,
      });
      
      if (onLog) {
        onLog(`Function result: ${functionResult}`, 'success');
      }
      
      // Add to conversation history
      const cleanedFunctionCall = `[FUNCTION: get_stats(data="${arrayData}")]`;
      conversationHistory += `${cleanedFunctionCall}\nResult: ${functionResult}\n\n`;
      
      // Add step without final response yet - will be set in step 2
      steps.push({
        step,
        llmOutput: cleanedFunctionCall,
        functionCall: { function: 'get_stats', arguments: `data="${arrayData}"` },
        functionResult,
        finalResponse: null,
      });
      
      // Add instruction to output answer after getting result, then continue to step 2 for final answer generation
      conversationHistory += `The answer is ${functionResult}. Output the final answer.\n\n`;
      continue;
    }

    // For text goals with inferred operation, directly execute on step 1
    if (hasInferredTextOperation && step === 1 && textToProcess !== null && inferredOperation !== null) {
      if (onLog) {
        onLog(`Directly executing inferred operation: ${inferredOperation} for text: "${textToProcess}"`, 'info');
      }
      
      // Directly execute the function call
      const functionResult = await executeTool('process_text', {
        text: textToProcess,
        operation: inferredOperation,
      });
      
      if (onLog) {
        onLog(`Function result: ${functionResult}`, 'success');
      }
      
      // Add to conversation history
      const cleanedFunctionCall = `[FUNCTION: process_text(text="${textToProcess}",operation="${inferredOperation}")]`;
      conversationHistory += `${cleanedFunctionCall}\nResult: ${functionResult}\n\n`;
      
      // Add step without final response yet - will be set in step 2
      steps.push({
        step,
        llmOutput: cleanedFunctionCall,
        functionCall: { function: 'process_text', arguments: `text="${textToProcess}",operation="${inferredOperation}"` },
        functionResult,
        finalResponse: null,
      });
      
      // Add instruction to output answer after getting result, then continue to step 2 for final answer generation
      conversationHistory += `The answer is ${functionResult}. Output the final answer.\n\n`;
      continue;
    }

    // Generate response from LLM using worker
    if (!functionCallingWorker) {
      throw new Error('Worker not initialized');
    }
    
    // Truncate history if needed to avoid tokenizer "offset out of bounds" errors
    const truncatedHistory = conversationHistory.length > maxHistoryLength
      ? conversationHistory.slice(-maxHistoryLength)
      : conversationHistory;
    
    if (onLog && conversationHistory.length > maxHistoryLength) {
      onLog(`Conversation history truncated from ${conversationHistory.length} to ${truncatedHistory.length} characters`, 'warning');
    }
    
    // Wrap in try-catch to handle tokenizer errors gracefully
    let llmOutput: string;
    try {
      llmOutput = await new Promise<string>((resolve, reject) => {
        if (!functionCallingWorker) {
          reject(new Error('Worker not initialized'));
          return;
        }

        const worker = functionCallingWorker;
        const id = crypto.randomUUID();

        const handler = (event: MessageEvent<WorkerResponse>): void => {
          if (event.data.id !== id) {
            return;
          }

          worker.removeEventListener('message', handler);

          if (event.data.type === 'result') {
            resolve(event.data.generatedText);
          } else if (event.data.type === 'error') {
            reject(new Error(event.data.error));
          }
        };

        worker.addEventListener('message', handler);

        const generateMessage: GenerateMessage = {
          id,
          type: 'generate',
          prompt: truncatedHistory,
          options: {
            max_new_tokens: 30,
            temperature: 0.2,
            do_sample: true,
            top_p: 0.4,
            repetition_penalty: 1.5,
          },
        };

        worker.postMessage(generateMessage);
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (onLog) {
        onLog(`Pipeline error: ${errorMsg}. History length: ${truncatedHistory.length}`, 'error');
      }
      // If it's an offset error, try with even shorter history
      if (errorMsg.includes('offset') || errorMsg.includes('out of bounds')) {
        const shorterHistory = truncatedHistory.slice(-1000);
        if (onLog) {
          onLog(`Retrying with shorter history: ${shorterHistory.length} chars`, 'warning');
        }
        try {
          llmOutput = await new Promise<string>((resolve, reject) => {
            if (!functionCallingWorker) {
              reject(new Error('Worker not initialized'));
              return;
            }

            const worker = functionCallingWorker;
            const id = crypto.randomUUID();

            const handler = (event: MessageEvent<WorkerResponse>): void => {
              if (event.data.id !== id) {
                return;
              }

              worker.removeEventListener('message', handler);

              if (event.data.type === 'result') {
                resolve(event.data.generatedText);
              } else if (event.data.type === 'error') {
                reject(new Error(event.data.error));
              }
            };

            worker.addEventListener('message', handler);

            const generateMessage: GenerateMessage = {
              id,
              type: 'generate',
              prompt: shorterHistory,
              options: {
                max_new_tokens: 100,
                temperature: 0.7,
                do_sample: true,
                top_p: 0.9,
                repetition_penalty: 1.1,
              },
            };

            worker.postMessage(generateMessage);
          });
        } catch (retryError) {
          const retryErrorMsg = retryError instanceof Error ? retryError.message : 'Unknown error';
          throw new Error(`Failed to generate response: ${retryErrorMsg}`);
        }
      } else {
        throw error;
      }
    }

    // Log raw LLM output for debugging
    if (onLog && llmOutput) {
      const preview = llmOutput.length > 100 ? llmOutput.slice(0, 100) + '...' : llmOutput;
      onLog(`LLM raw output: ${llmOutput.length} chars, preview: ${preview}`, 'info');
    }

    if (!llmOutput) {
      if (onLog) {
        onLog('No output from LLM', 'warning');
      }
      // Check if we have an array goal that we can still execute
      if (isArrayGoal && arrayData !== null) {
        if (onLog) {
          onLog('Attempting direct execution due to empty LLM output', 'warning');
        }
        // Directly execute the function call
        const functionResult = await executeTool('get_stats', {
          data: arrayData,
        });
        
        if (onLog) {
          onLog(`Function result: ${functionResult}`, 'success');
        }
        
        steps.push({
          step,
          llmOutput: '',
          functionCall: { function: 'get_stats', arguments: `data="${arrayData}"` },
          functionResult,
          finalResponse: functionResult.trim(),
        });
        break;
      }
      
      // Check if we have a text goal with inferred operation that we can still execute
      if (hasInferredTextOperation && textToProcess !== null && inferredOperation !== null) {
        if (onLog) {
          onLog('Attempting direct execution due to empty LLM output', 'warning');
        }
        // Directly execute the function call
        const functionResult = await executeTool('process_text', {
          text: textToProcess,
          operation: inferredOperation,
        });
        
        if (onLog) {
          onLog(`Function result: ${functionResult}`, 'success');
        }
        
        steps.push({
          step,
          llmOutput: '',
          functionCall: { function: 'process_text', arguments: `text="${textToProcess}",operation="${inferredOperation}"` },
          functionResult,
          finalResponse: functionResult.trim(),
        });
        break;
      }
      break;
    }

    // Remove the conversation history prefix from output
    // Use truncated history for comparison since that's what was sent to the model
    let newText = llmOutput.startsWith(truncatedHistory)
      ? llmOutput.slice(truncatedHistory.length)
      : llmOutput;
    
    // Clean up output - extract only valid function calls, remove all garbage
    // Base models often generate junk, so we extract only the relevant part
    const functionCallMatch = newText.match(/\[FUNCTION:\s*(\w+)\s*\(([^)]+)\)\]/);
    if (functionCallMatch) {
      // Extract only the function call, ensure it's a valid function name
      const functionName = functionCallMatch[1];
      const validFunctions = ['calculate', 'process_text', 'get_stats'];
      if (validFunctions.includes(functionName)) {
        newText = functionCallMatch[0];
      } else {
        // Invalid function name, try to find a valid one elsewhere
        const validFunctionMatch = newText.match(/\[FUNCTION:\s*(calculate|process_text|get_stats)\s*\([^)]+\)\]/);
        if (validFunctionMatch) {
          newText = validFunctionMatch[0];
        } else {
          newText = '';
          if (onLog) {
            onLog('Cleaned output is empty, no valid function call detected', 'warning');
          }
        }
      }
    } else {
      // If no function call format, try to find function calls in raw text
      // Check for calculate, get_stats, or process_text calls
      const functionMatch = newText.match(/(?:calculate|get_stats|process_text)\s*\([^)]+\)/i);
      if (functionMatch) {
        newText = `[FUNCTION: ${functionMatch[0]}]`;
      } else {
        newText = '';
        if (onLog) {
          onLog('Cleaned output is empty, no function call detected', 'warning');
        }
      }
    }

    // Check for function call
    const functionCall = parseFunctionCall(newText);

    if (functionCall) {
      if (onLog) {
        onLog(`Function call detected: ${functionCall.function}(${functionCall.arguments})`, 'info');
      }

      // Extract arguments
      const args = extractFunctionArguments(functionCall.arguments);

      // Execute function
      let functionResult = '';
      try {
        functionResult = await executeTool(functionCall.function, args);
        if (onLog) {
          onLog(`Function result: ${functionResult}`, 'success');
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        functionResult = `Error: ${errorMsg}`;
        if (onLog) {
          onLog(`Function error: ${errorMsg}`, 'error');
        }
      }

      // Add to conversation history with cleaned function call
      const cleanedFunctionCall = `[FUNCTION: ${functionCall.function}(${functionCall.arguments})]`;
      conversationHistory += `${cleanedFunctionCall}\nResult: ${functionResult}\n\n`;
      
      // Trim history if it gets too long to prevent tokenizer issues
      if (conversationHistory.length > maxHistoryLength) {
        // Keep the initial prompt and the most recent interactions
        const initialPromptMatch = conversationHistory.match(/^(.+?)(\n\n)/);
        if (initialPromptMatch) {
          const initialPrompt = initialPromptMatch[0];
          const recentInteractions = conversationHistory.slice(conversationHistory.length - (maxHistoryLength - initialPrompt.length));
          conversationHistory = initialPrompt + recentInteractions;
        } else {
          // Fallback: just keep the last maxHistoryLength characters
          conversationHistory = conversationHistory.slice(-maxHistoryLength);
        }
      }

      // Check if we have the answer - for math goals, if we got a numeric result, that's the answer
      // For array goals with get_stats, the result is the answer
      // For text goals with process_text, the result is the answer
      const hasAnswer = (isMathGoal && functionResult && /^\d+$/.test(functionResult.trim())) ||
                       (isArrayGoal && functionResult && functionCall.function === 'get_stats') ||
                       (functionResult && functionCall.function === 'process_text');
      
      if (hasAnswer) {
        // We have the answer, stop here
        steps.push({
          step,
          llmOutput: newText,
          functionCall,
          functionResult,
          finalResponse: functionResult.trim(),
        });
        break;
      }

      steps.push({
        step,
        llmOutput: newText,
        functionCall,
        functionResult,
        finalResponse: null,
      });

      // Add instruction to output answer after getting result
      conversationHistory += `The answer is ${functionResult}. Output the final answer.\n\n`;

      // Continue to next iteration
      continue;
    }

    // No function call, this is the final response
    // ALWAYS prioritize function results from previous steps over LLM output
    let finalResponse = '';
    
    // First, check if we have a previous step with a function result
    // This should always take precedence over LLM garbage output
    let lastStepWithResult: AgentStep | null = null;
    for (let i = steps.length - 1; i >= 0; i--) {
      const stepItem = steps[i];
      if (stepItem.functionResult !== null) {
        lastStepWithResult = stepItem;
        break;
      }
    }
    
    if (lastStepWithResult && lastStepWithResult.functionResult) {
      // Use function result from previous step as final answer
      finalResponse = lastStepWithResult.functionResult.trim();
      if (onLog) {
        onLog('Using function result from previous step as final answer', 'info');
      }
    } else {
      // No function result available, try to extract from LLM output
      finalResponse = newText.trim();
      
      // If newText is empty but we have llmOutput, try to extract the answer
      if (!finalResponse && llmOutput) {
        if (onLog) {
          onLog('Extracting final answer from LLM output (no function call detected)', 'info');
        }
        
        // Remove conversation history prefix to get just the new text
        const rawNewText = llmOutput.startsWith(truncatedHistory)
          ? llmOutput.slice(truncatedHistory.length)
          : llmOutput;
        
        // Look for patterns like "The answer is X" or "Final answer: X"
        const answerPattern = rawNewText.match(/(?:The answer is|Final answer:?|Answer:?)\s*(.+?)(?:\n|$)/i);
        if (answerPattern && answerPattern[1]) {
          finalResponse = answerPattern[1].trim();
        } else {
          // Look for the result value from previous step in conversation history
          const resultMatch = conversationHistory.match(/Result:\s*(.+?)(?:\n\n|$)/);
          if (resultMatch && resultMatch[1]) {
            finalResponse = resultMatch[1].trim();
          } else {
            // Try to extract meaningful text from rawNewText
            const cleanText = rawNewText.trim();
            if (cleanText && cleanText.length > 0 && cleanText.length < 200) {
              finalResponse = cleanText;
            } else {
              finalResponse = 'Unable to extract clear answer';
            }
          }
        }
      }
    }
    
    // If response contains garbage (C++ code, special chars), try to extract a number or simple answer
    if (finalResponse.includes('#include') || finalResponse.includes('@endif') || finalResponse.length > 200) {
      // Try to extract a number from the response
      const numberMatch = finalResponse.match(/\d+/);
      if (numberMatch) {
        finalResponse = numberMatch[0];
      } else {
        // If no number, take first reasonable sentence
        const sentenceMatch = finalResponse.match(/^[^#@\n]{1,100}/);
        if (sentenceMatch) {
          finalResponse = sentenceMatch[0].trim();
        } else {
          finalResponse = 'Unable to extract clear answer';
        }
      }
    }
    
    steps.push({
      step,
      llmOutput: newText,
      functionCall: null,
      functionResult: null,
      finalResponse,
    });

    break;
  }

  return steps;
}

/**
 * Check if agent model is loaded
 */
export function isAgentModelLoaded(): boolean {
  return isLoaded && functionCallingWorker !== null;
}

/**
 * Get the model ID
 */
export function getModelId(): string {
  return 'Xenova/distilgpt2';
}

