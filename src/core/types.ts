export interface ToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | ContentPart[] | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export interface ToolSchema {
	type: 'function';
	function: { name: string; description: string; parameters: object };
}

export interface Usage {
	promptTokens: number;
	completionTokens: number;
	cost?: number;
	/** The model that actually answered, which matters when routing with `auto`. */
	model?: string;
}

export interface ModelInfo {
	id: string;
	name: string;
	family: string;
	description?: string;
	contextWindow: number;
	maxOutputTokens: number;
	supportsTools: boolean;
	supportsImages: boolean;
	reasoningEfforts: string[];
}

export type StreamEvent =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'tool_call'; call: ToolCall }
	| { type: 'usage'; usage: Usage }
	| { type: 'guard'; result: string; risk: string; recommendation: string }
	| { type: 'finish'; reason: string };

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	tools?: ToolSchema[];
	toolChoice?: 'auto' | 'required';
	maxTokens?: number;
	reasoningEffort?: string;
}

export interface ChatStreamer {
	streamChat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
}
