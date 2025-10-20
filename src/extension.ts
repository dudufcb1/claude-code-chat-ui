import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as util from 'util';
import * as path from 'path';
import getHtml from './ui';

const exec = util.promisify(cp.exec);

// Shared provider reference for deactivate cleanup
let sharedProvider: ClaudeChatProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
	console.log('Claude Code Chat extension is being activated!');

	// Attempt to auto-start codebase watcher for the workspace
	try {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (workspaceFolder) {
			const workspacePath = workspaceFolder.uri.fsPath;
			const codebaseDir = path.join(workspacePath, '.codebase');
			const fs = require('fs');
			const provider = new ClaudeChatProvider(context.extensionUri, context);
			if (fs.existsSync(codebaseDir)) {
				provider['startCodebaseWatcher']?.();
			} else {
				vscode.window.showInformationMessage(
					'No .codebase folder detected in this workspace. Do you want to start indexing this folder?',
					'Yes', 'No'
				).then(answer => {
					if (answer === 'Yes') {
						provider['startCodebaseWatcher']?.();
					}
				});
			}
		}
	} catch (e) {
		console.warn('codebase auto-start failed:', (e as any)?.message || e);
	}

	// Load workspace .env and map DISABLE_WSL -> CLAUDE_CODE_CHAT_DISABLE_WSL
	try {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (workspaceFolder) {
			const envPath = path.join(workspaceFolder.uri.fsPath, '.env');
			const fs = require('fs');
			if (fs.existsSync(envPath)) {
				const content: string = fs.readFileSync(envPath, 'utf8');
				for (const line of content.split(/\r?\n/)) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith('#')) continue;
					const idx = trimmed.indexOf('=');
					if (idx === -1) continue;
					const key = trimmed.slice(0, idx).trim();
					const value = trimmed.slice(idx + 1).trim();
					if (key === 'DISABLE_WSL') {
						const v = value.toLowerCase();
						if (v === '1' || v === 'true' || v === 'yes') {
							process.env.CLAUDE_CODE_CHAT_DISABLE_WSL = '1';
						}
					}
				}
			}
		}
	} catch (e: any) {
		console.warn('Failed to load .env for DISABLE_WSL:', e?.message || e);
	}

	const provider = new ClaudeChatProvider(context.extensionUri, context);
	sharedProvider = provider;

	const disposable = vscode.commands.registerCommand('claude-code-chat.openChat', (column?: vscode.ViewColumn) => {
		console.log('Claude Code Chat command executed!');
		provider.show(column);
	});

	const loadConversationDisposable = vscode.commands.registerCommand('claude-code-chat.loadConversation', (filename: string) => {
		provider.loadConversation(filename);
	});

	// Register webview view provider for sidebar chat (using shared provider instance)
	const webviewProvider = new ClaudeChatWebviewProvider(context.extensionUri, context, provider);
	vscode.window.registerWebviewViewProvider('claude-code-chat.chat', webviewProvider);

	// Listen for configuration changes
	const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(event => {
		// Ignore WSL config changes when disabled via env or not on Windows
		const wslDisabledEnv = (process.env.CLAUDE_CODE_CHAT_DISABLE_WSL || '').toLowerCase();
		const wslGloballyDisabled = wslDisabledEnv === '1' || wslDisabledEnv === 'true' || wslDisabledEnv === 'yes';
		const isWindows = process.platform === 'win32';
		if (!wslGloballyDisabled && isWindows && event.affectsConfiguration('claudeCodeChat.wsl')) {
			console.log('WSL configuration changed, starting new session');
			provider.newSessionOnConfigChange();
		}
	});

	// Create status bar item
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.text = "Claude";
	statusBarItem.tooltip = "Open Claude Code Chat (Ctrl+Shift+C)";
	statusBarItem.command = 'claude-code-chat.openChat';
	statusBarItem.show();

	context.subscriptions.push(disposable, loadConversationDisposable, configChangeDisposable, statusBarItem);
	console.log('Claude Code Chat extension activation completed successfully!');
}

export function deactivate() {
	try {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const workspacePath = workspaceFolder?.uri.fsPath;
		if (sharedProvider && workspacePath) {
			// Best-effort stop to avoid leaving detached watchers running
			sharedProvider.stopCodebaseWatcherSync();
		}
	} catch {}
}

interface ConversationData {
	sessionId: string;
	startTime: string | undefined;
	endTime: string;
	messageCount: number;
	totalCost: number;
	totalTokens: {
		input: number;
		output: number;
	};
	messages: Array<{ timestamp: string, messageType: string, data: any }>;
	filename: string;
}

class ClaudeChatWebviewProvider implements vscode.WebviewViewProvider {
	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _context: vscode.ExtensionContext,
		private readonly _chatProvider: ClaudeChatProvider
	) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri]
		};

		// Use the shared chat provider instance for the sidebar
		this._chatProvider.showInWebview(webviewView.webview, webviewView);

		// Handle visibility changes to reinitialize when sidebar reopens
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				// Close main panel when sidebar becomes visible
				if (this._chatProvider._panel) {
					console.log('Closing main panel because sidebar became visible');
					this._chatProvider._panel.dispose();
					this._chatProvider._panel = undefined;
				}
				this._chatProvider.reinitializeWebview();
			}
		});
	}
}


class ClaudeChatProvider {
	public _panel: vscode.WebviewPanel | undefined;
	private _webview: vscode.Webview | undefined;
	private _webviewView: vscode.WebviewView | undefined;
	private _disposables: vscode.Disposable[] = [];
	private _messageHandlerDisposable: vscode.Disposable | undefined;
	private _totalCost: number = 0;
	private _totalTokensInput: number = 0;
	private _totalTokensOutput: number = 0;
	private _requestCount: number = 0;
	private _currentSessionId: string | undefined;
	private _backupRepoPath: string | undefined;
	private _commits: Array<{ id: string, sha: string, message: string, timestamp: string }> = [];
	private _conversationsPath: string | undefined;
	private _permissionRequestsPath: string | undefined;
	private _permissionWatcher: vscode.FileSystemWatcher | undefined;
	private _pendingPermissionResolvers: Map<string, (approved: boolean) => void> | undefined;
	private _currentConversation: Array<{ timestamp: string, messageType: string, data: any }> = [];
	private _conversationStartTime: string | undefined;
	private _conversationIndex: Array<{
		filename: string,
		sessionId: string,
		startTime: string,
		endTime: string,
		messageCount: number,
		totalCost: number,
		firstUserMessage: string,
		lastUserMessage: string
	}> = [];
	private _currentClaudeProcess: cp.ChildProcess | undefined;
	private _selectedModel: string = 'default'; // Default model
	private _isProcessing: boolean | undefined;
	private _draftMessage: string = '';

	// Output channel for logs
	private _output: vscode.OutputChannel = vscode.window.createOutputChannel('Claude Code Chat');

	// Cached codebase CLI command/path
	private _codebasePathCache: string | undefined;

	// Claude instance management
	private _selectedInstance: string = 'default';
	private _availableInstances: Array<{
		name: string;           // e.g., 'default', '.claude-codex'
		displayName: string;    // e.g., 'Default', 'Codex'
		path: string;           // Full resolved path
		flags: string[];        // e.g., ['--dangerously-skip-permissions']
		isValid: boolean;       // Has valid config
	}> = [];
	private _frozenInstanceConfigDir: string | undefined; // Frozen during spawn

	// Indexing status management
	private _indexingStatusInterval: NodeJS.Timeout | undefined;
	private _lastIndexingState: string | undefined;
	private _codebaseStatePath: string | undefined;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _context: vscode.ExtensionContext
	) {

		// Initialize backup repository and conversations
		this._initializeBackupRepo();
		this._initializeConversations();
		this._initializeMCPConfig();

		// Load conversation index from workspace state
		this._conversationIndex = this._context.workspaceState.get('claude.conversationIndex', []);

		// Load saved model preference
		this._selectedModel = this._context.workspaceState.get('claude.selectedModel', 'default');

		// Detect and load Claude instances
		this._availableInstances = this._detectClaudeInstances();
		this._selectedInstance = this._loadSelectedInstance();

		// Initialize codebase state path
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			this._codebaseStatePath = path.join(workspaceFolders[0].uri.fsPath, '.codebase', 'state.json');
		}

		// Resume session from latest conversation
		const latestConversation = this._getLatestConversation();
		this._currentSessionId = latestConversation?.sessionId;
	}

	public show(column: vscode.ViewColumn | vscode.Uri = vscode.ViewColumn.Two) {
		// Handle case where a URI is passed instead of ViewColumn
		const actualColumn = column instanceof vscode.Uri ? vscode.ViewColumn.Two : column;

		// Close sidebar if it's open
		this._closeSidebar();

		if (this._panel) {
			this._panel.reveal(actualColumn);
			return;
		}

		this._panel = vscode.window.createWebviewPanel(
			'claudeChat',
			'Claude Code Chat',
			actualColumn,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [this._extensionUri]
			}
		);

		// Set icon for the webview tab using URI path
		const iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon-bubble.png');
		this._panel.iconPath = iconPath;

		this._panel.webview.html = this._getHtmlForWebview();

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		this._setupWebviewMessageHandler(this._panel.webview);
		this._initializePermissions();

		// Resume session from latest conversation
		const latestConversation = this._getLatestConversation();
		this._currentSessionId = latestConversation?.sessionId;

		// Load latest conversation history if available
		if (latestConversation) {
			this._loadConversationHistory(latestConversation.filename);
		}

		// Send ready message immediately
		setTimeout(() => {
			// If no conversation to load, send ready immediately
			if (!latestConversation) {
				this._sendReadyMessage();
			}
		}, 100);
	}

	private _postMessage(message: any) {
		if (this._panel && this._panel.webview) {
			this._panel.webview.postMessage(message);
		} else if (this._webview) {
			this._webview.postMessage(message);
		}
	}

	private _sendReadyMessage() {
		// Send current session info if available
		/*if (this._currentSessionId) {
			this._postMessage({
				type: 'sessionResumed',
				data: {
					sessionId: this._currentSessionId
				}
			});
		}*/

		this._postMessage({
			type: 'ready',
			data: this._isProcessing ? 'Claude is working...' : 'Ready to chat with Claude Code! Type your message below.'
		});

		// Send current model to webview
		this._postMessage({
			type: 'modelSelected',
			model: this._selectedModel
		});

		// Send available instances to webview
		this._sendAvailableInstances();

		// Send platform information to webview
		this._sendPlatformInfo();

		// Send current settings to webview
		this._sendCurrentSettings();

		// Send saved draft message if any
		if (this._draftMessage) {
			this._postMessage({
				type: 'restoreInputText',
				data: this._draftMessage
			});
		}

		// Start indexing status polling
		this._startIndexingStatusPolling();
	}

	private _handleWebviewMessage(message: any) {
		switch (message.type) {
			case 'sendMessage':
				this._sendMessageToClaude(message.text, message.planMode, message.thinkingMode, message.parallelAgents);
				return;
			case 'newSession':
				this._newSession();
				return;
			case 'restoreCommit':
				this._restoreToCommit(message.commitSha);
				return;
			case 'getConversationList':
				this._sendConversationList();
				return;
			case 'getWorkspaceFiles':
				this._sendWorkspaceFiles(message.searchTerm);
				return;
			case 'selectImageFile':
				this._selectImageFile();
				return;
			case 'loadConversation':
				this.loadConversation(message.filename);
				return;
			case 'stopRequest':
				this._stopClaudeProcess();
				return;
			case 'getSettings':
				this._sendCurrentSettings();
				return;
			case 'updateSettings':
				this._updateSettings(message.settings);
				return;
			case 'getClipboardText':
				this._getClipboardText();
				return;
			case 'selectModel':
				this._setSelectedModel(message.model);
				return;
			case 'selectInstance':
				this._setSelectedInstance(message.instance, message.useGlobally || false);
				return;
			case 'getInstances':
				this._sendAvailableInstances();
				return;
			case 'rescanInstances':
				this._availableInstances = this._detectClaudeInstances();
				this._sendAvailableInstances();
				return;
			case 'openModelTerminal':
				this._openModelTerminal();
				return;
			case 'executeSlashCommand':
				this._executeSlashCommand(message.command);
				return;
			case 'codebaseCommand':
				this._handleCodebaseCommand(message.cmd);
				return;
			case 'dismissWSLAlert':
				this._dismissWSLAlert();
				return;
			case 'openFile':
				this._openFileInEditor(message.filePath);
				return;
			case 'createImageFile':
				this._createImageFile(message.imageData, message.imageType);
				return;
			case 'permissionResponse':
				this._handlePermissionResponse(message.id, message.approved, message.alwaysAllow);
				return;
			case 'getPermissions':
				this._sendPermissions();
				return;
			case 'removePermission':
				this._removePermission(message.toolName, message.command);
				return;
			case 'addPermission':
				this._addPermission(message.toolName, message.command);
				return;
			case 'loadMCPServers':
				this._loadMCPServers();
				return;
			case 'saveMCPServer':
				this._saveMCPServer(message.name, message.config);
				return;
			case 'deleteMCPServer':
				this._deleteMCPServer(message.name);
				return;
			case 'getCustomSnippets':
				this._sendCustomSnippets();
				return;
			case 'saveCustomSnippet':
				this._saveCustomSnippet(message.snippet);
				return;
			case 'deleteCustomSnippet':
				this._deleteCustomSnippet(message.snippetId);
				return;
			case 'enableYoloMode':
				this._enableYoloMode();
				return;
			case 'saveInputText':
				this._saveInputText(message.text);
				return;
		}
	}

	private _setupWebviewMessageHandler(webview: vscode.Webview) {
		// Dispose of any existing message handler
		if (this._messageHandlerDisposable) {
			this._messageHandlerDisposable.dispose();
		}

		// Set up new message handler
		this._messageHandlerDisposable = webview.onDidReceiveMessage(
			message => this._handleWebviewMessage(message),
			null,
			this._disposables
		);
	}

	private _closeSidebar() {
		if (this._webviewView) {
			// Switch VS Code to show Explorer view instead of chat sidebar
			vscode.commands.executeCommand('workbench.view.explorer');
		}
	}

	public showInWebview(webview: vscode.Webview, webviewView?: vscode.WebviewView) {
		// Close main panel if it's open
		if (this._panel) {
			console.log('Closing main panel because sidebar is opening');
			this._panel.dispose();
			this._panel = undefined;
		}

		this._webview = webview;
		this._webviewView = webviewView;
		this._webview.html = this._getHtmlForWebview();

		this._setupWebviewMessageHandler(this._webview);
		this._initializePermissions();

		// Initialize the webview
		this._initializeWebview();
	}

	private _initializeWebview() {
		// Resume session from latest conversation
		const latestConversation = this._getLatestConversation();
		this._currentSessionId = latestConversation?.sessionId;

		// Load latest conversation history if available
		if (latestConversation) {
			this._loadConversationHistory(latestConversation.filename);
		} else {
			// If no conversation to load, send ready immediately
			setTimeout(() => {
				this._sendReadyMessage();
			}, 100);
		}
	}

	public reinitializeWebview() {
		// Only reinitialize if we have a webview (sidebar)
		if (this._webview) {
			this._initializePermissions();
			this._initializeWebview();
			// Set up message handler for the webview
			this._setupWebviewMessageHandler(this._webview);
		}
	}

	private async _sendMessageToClaude(message: string, planMode?: boolean, thinkingMode?: boolean, parallelAgents?: boolean) {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const cwd = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();

		// Get thinking intensity setting
		const configThink = vscode.workspace.getConfiguration('claudeCodeChat');
		const thinkingIntensity = configThink.get<string>('thinking.intensity', 'think');

		// Prepend mode instructions if enabled
		let actualMessage = message;
		if (parallelAgents) {
			actualMessage = 'PARALLELIZATION WITH SUBAGENTS (THIS MESSAGE ONLY): Use parallel subagents for the next task if it’s effective. If it doesn’t help, proceed sequentially.\n\n' + actualMessage;
		}

		if (planMode) {
			actualMessage = 'PLAN FIRST FOR THIS MESSAGE ONLY: Plan first before making any changes. Show me in detail what you will change and wait for my explicit approval in a separate message before proceeding. Do not implement anything until I confirm. This planning requirement applies ONLY to this current message. \n\n' + actualMessage;
		}
		if (thinkingMode) {
			let thinkingPrompt = '';
			const thinkingMesssage = ' THROUGH THIS STEP BY STEP: \n'
			switch (thinkingIntensity) {
				case 'think':
					thinkingPrompt = 'THINK';
					break;
				case 'think-hard':
					thinkingPrompt = 'THINK HARD';
					break;
				case 'think-harder':
					thinkingPrompt = 'THINK HARDER';
					break;
				case 'ultrathink':
					thinkingPrompt = 'ULTRATHINK';
					break;
				default:
					thinkingPrompt = 'THINK';
			}
			actualMessage = thinkingPrompt + thinkingMesssage + actualMessage;
		}

		this._isProcessing = true;

		// Clear draft message since we're sending it
		this._draftMessage = '';

		// Show original user input in chat and save to conversation (without mode prefixes)
		this._sendAndSaveMessage({
			type: 'userInput',
			data: message
		});

		// Set processing state to true
		this._postMessage({
			type: 'setProcessing',
			data: { isProcessing: true }
		});

		// Create backup commit before Claude makes changes
		try {
			await this._createBackupCommit(message);
		}
		catch (e) {
			console.log("error", e);
		}

		// Show loading indicator
		this._postMessage({
			type: 'loading',
			data: 'Claude is working...'
		});

		// Build command arguments with session management
		const args = [
			'-p',
			'--output-format', 'stream-json', '--verbose'
		];

		// Get configuration
		const config = vscode.workspace.getConfiguration('claudeCodeChat');
		const yoloMode = config.get<boolean>('permissions.yoloMode', false);

		if (yoloMode) {
			// Yolo mode: skip all permissions regardless of MCP config
			args.push('--dangerously-skip-permissions');
		} else {
			// Add MCP configuration for permissions
			const mcpConfigPath = this.getMCPConfigPath();
			if (mcpConfigPath) {
				args.push('--mcp-config', this.convertToWSLPath(mcpConfigPath));
				args.push('--allowedTools', 'mcp__claude-code-chat-permissions__approval_prompt');
				args.push('--permission-prompt-tool', 'mcp__claude-code-chat-permissions__approval_prompt');
			}
		}

		// Add model selection if not using default
		if (this._selectedModel && this._selectedModel !== 'default') {
			args.push('--model', this._selectedModel);
		}

		// Add session resume if we have a current session
		if (this._currentSessionId) {
			args.push('--resume', this._currentSessionId);
			console.log('Resuming session:', this._currentSessionId);
		} else {
			console.log('Starting new session');
		}

		console.log('Claude command args:', args);
		const wslDisabledEnv = (process.env.CLAUDE_CODE_CHAT_DISABLE_WSL || '').toLowerCase();
		const wslGloballyDisabled = wslDisabledEnv === '1' || wslDisabledEnv === 'true' || wslDisabledEnv === 'yes';
		const wslEnabled = !wslGloballyDisabled && config.get<boolean>('wsl.enabled', false);
		const wslDistro = config.get<string>('wsl.distro', 'Ubuntu');
		const nodePath = config.get<string>('wsl.nodePath', '/usr/bin/node');
		const claudePath = config.get<string>('wsl.claudePath', '/usr/local/bin/claude');

		// Freeze the CLAUDE_CONFIG_DIR for this spawn to avoid race conditions
		this._frozenInstanceConfigDir = this._getClaudeConfigDir();

		// Build environment with CLAUDE_CONFIG_DIR if needed
		const spawnEnv: NodeJS.ProcessEnv = {
			...process.env,
			FORCE_COLOR: '0',
			NO_COLOR: '1'
		};

		// Add CLAUDE_CONFIG_DIR if instance is not default
		if (this._frozenInstanceConfigDir) {
			spawnEnv.CLAUDE_CONFIG_DIR = this._frozenInstanceConfigDir;
			console.log('Using CLAUDE_CONFIG_DIR:', this._frozenInstanceConfigDir);
		}

		let claudeProcess: cp.ChildProcess;

		if (wslEnabled) {
			// Use WSL with bash -ic for proper environment loading
			console.log('Using WSL configuration:', { wslDistro, nodePath, claudePath });

			// Export CLAUDE_CONFIG_DIR in the bash command if needed
			const envPrefix = this._frozenInstanceConfigDir
				? `CLAUDE_CONFIG_DIR="${this._frozenInstanceConfigDir}" `
				: '';

			const wslCommand = `${envPrefix}"${nodePath}" --no-warnings --enable-source-maps "${claudePath}" ${args.join(' ')}`;

			claudeProcess = cp.spawn('wsl', ['-d', wslDistro, 'bash', '-ic', wslCommand], {
				cwd: cwd,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: spawnEnv
			});
		} else {
			// Use native claude command
			console.log('Using native Claude command');
			claudeProcess = cp.spawn('claude', args, {
				shell: process.platform === 'win32',
				cwd: cwd,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: spawnEnv
			});
		}

		// Store process reference for potential termination
		this._currentClaudeProcess = claudeProcess;

		// Send the message to Claude's stdin (with mode prefixes if enabled)
		if (claudeProcess.stdin) {
			claudeProcess.stdin.write(actualMessage + '\n');
			claudeProcess.stdin.end();
		}

		let rawOutput = '';
		let errorOutput = '';

		if (claudeProcess.stdout) {
			claudeProcess.stdout.on('data', (data) => {
				rawOutput += data.toString();

				// Process JSON stream line by line
				const lines = rawOutput.split('\n');
				rawOutput = lines.pop() || ''; // Keep incomplete line for next chunk

				for (const line of lines) {
					if (line.trim()) {
						try {
							const jsonData = JSON.parse(line.trim());
							this._processJsonStreamData(jsonData);
						} catch (error) {
							console.log('Failed to parse JSON line:', line, error);
						}
					}
				}
			});
		}

		if (claudeProcess.stderr) {
			claudeProcess.stderr.on('data', (data) => {
				errorOutput += data.toString();
			});
		}

		claudeProcess.on('close', (code) => {
			console.log('Claude process closed with code:', code);
			console.log('Claude stderr output:', errorOutput);

			if (!this._currentClaudeProcess) {
				return;
			}

			// Clear process reference
			this._currentClaudeProcess = undefined;

			// Clear loading indicator and set processing to false
			this._postMessage({
				type: 'clearLoading'
			});

			// Reset processing state
			this._isProcessing = false;

			// Clear processing state
			this._postMessage({
				type: 'setProcessing',
				data: { isProcessing: false }
			});

			if (code !== 0 && errorOutput.trim()) {
				// Error with output
				this._sendAndSaveMessage({
					type: 'error',
					data: errorOutput.trim()
				});
			}
		});

		claudeProcess.on('error', (error) => {
			console.log('Claude process error:', error.message);

			if (!this._currentClaudeProcess) {
				return;
			}

			// Clear process reference
			this._currentClaudeProcess = undefined;

			this._postMessage({
				type: 'clearLoading'
			});

			this._isProcessing = false;

			// Clear processing state
			this._postMessage({
				type: 'setProcessing',
				data: { isProcessing: false }
			});

			// Check if claude command is not installed
			if (error.message.includes('ENOENT') || error.message.includes('command not found')) {
				this._sendAndSaveMessage({
					type: 'error',
					data: 'Install claude code first: https://www.anthropic.com/claude-code'
				});
			} else {
				this._sendAndSaveMessage({
					type: 'error',
					data: `Error running Claude: ${error.message}`
				});
			}
		});
	}

	private _processJsonStreamData(jsonData: any) {
		switch (jsonData.type) {
			case 'system':
				if (jsonData.subtype === 'init') {
					// System initialization message - session ID will be captured from final result
					console.log('System initialized');
					this._currentSessionId = jsonData.session_id;
					//this._sendAndSaveMessage({ type: 'init', data: { sessionId: jsonData.session_id; } })

					// Show session info in UI
					this._sendAndSaveMessage({
						type: 'sessionInfo',
						data: {
							sessionId: jsonData.session_id,
							tools: jsonData.tools || [],
							mcpServers: jsonData.mcp_servers || []
						}
					});
				}
				break;

			case 'assistant':
				if (jsonData.message && jsonData.message.content) {
					// Track token usage in real-time if available
					if (jsonData.message.usage) {
						this._totalTokensInput += jsonData.message.usage.input_tokens || 0;
						this._totalTokensOutput += jsonData.message.usage.output_tokens || 0;

						// Send real-time token update to webview
						this._sendAndSaveMessage({
							type: 'updateTokens',
							data: {
								totalTokensInput: this._totalTokensInput,
								totalTokensOutput: this._totalTokensOutput,
								currentInputTokens: jsonData.message.usage.input_tokens || 0,
								currentOutputTokens: jsonData.message.usage.output_tokens || 0,
								cacheCreationTokens: jsonData.message.usage.cache_creation_input_tokens || 0,
								cacheReadTokens: jsonData.message.usage.cache_read_input_tokens || 0
							}
						});
					}

					// Process each content item in the assistant message
					for (const content of jsonData.message.content) {
						if (content.type === 'text' && content.text.trim()) {
							// Show text content and save to conversation
							this._sendAndSaveMessage({
								type: 'output',
								data: content.text.trim()
							});
						} else if (content.type === 'thinking' && content.thinking.trim()) {
							// Show thinking content and save to conversation
							this._sendAndSaveMessage({
								type: 'thinking',
								data: content.thinking.trim()
							});
						} else if (content.type === 'tool_use') {
							// Show tool execution with better formatting
							const toolInfo = `🔧 Executing: ${content.name}`;
							let toolInput = '';

							if (content.input) {
								// Special formatting for TodoWrite to make it more readable
								if (content.name === 'TodoWrite' && content.input.todos) {
									toolInput = '\nTodo List Update:';
									for (const todo of content.input.todos) {
										const status = todo.status === 'completed' ? '✅' :
											todo.status === 'in_progress' ? '🔄' : '⏳';
										toolInput += `\n${status} ${todo.content} (priority: ${todo.priority})`;
									}
								} else {
									// Send raw input to UI for formatting
									toolInput = '';
								}
							}

							// Show tool use and save to conversation
							this._sendAndSaveMessage({
								type: 'toolUse',
								data: {
									toolInfo: toolInfo,
									toolInput: toolInput,
									rawInput: content.input,
									toolName: content.name
								}
							});
						}
					}
				}
				break;

			case 'user':
				if (jsonData.message && jsonData.message.content) {
					// Process tool results from user messages
					for (const content of jsonData.message.content) {
						if (content.type === 'tool_result') {
							let resultContent = content.content || 'Tool executed successfully';

							// Stringify if content is an object or array
							if (typeof resultContent === 'object' && resultContent !== null) {
								resultContent = JSON.stringify(resultContent, null, 2);
							}

							const isError = content.is_error || false;

							// Find the last tool use to get the tool name
							const lastToolUse = this._currentConversation[this._currentConversation.length - 1]

							const toolName = lastToolUse?.data?.toolName;

							// Don't send tool result for Read and Edit tools unless there's an error
							if ((toolName === 'Read' || toolName === 'Edit' || toolName === 'TodoWrite' || toolName === 'MultiEdit') && !isError) {
								// Still send to UI to hide loading state, but mark it as hidden
								this._sendAndSaveMessage({
									type: 'toolResult',
									data: {
										content: resultContent,
										isError: isError,
										toolUseId: content.tool_use_id,
										toolName: toolName,
										hidden: true
									}
								});
							} else {
								// Show tool result and save to conversation
								this._sendAndSaveMessage({
									type: 'toolResult',
									data: {
										content: resultContent,
										isError: isError,
										toolUseId: content.tool_use_id,
										toolName: toolName
									}
								});
							}
						}
					}
				}
				break;

			case 'result':
				if (jsonData.subtype === 'success') {
					// Check for login errors
					if (jsonData.is_error && jsonData.result && jsonData.result.includes('Invalid API key')) {
						this._handleLoginRequired();
						return;
					}

					this._isProcessing = false;

					// Capture session ID from final result
					if (jsonData.session_id) {
						const isNewSession = !this._currentSessionId;
						const sessionChanged = this._currentSessionId && this._currentSessionId !== jsonData.session_id;

						console.log('Session ID found in result:', {
							sessionId: jsonData.session_id,
							isNewSession,
							sessionChanged,
							currentSessionId: this._currentSessionId
						});

						this._currentSessionId = jsonData.session_id;

						// Show session info in UI
						this._sendAndSaveMessage({
							type: 'sessionInfo',
							data: {
								sessionId: jsonData.session_id,
								tools: jsonData.tools || [],
								mcpServers: jsonData.mcp_servers || []
							}
						});
					}

					// Clear processing state
					this._postMessage({
						type: 'setProcessing',
						data: { isProcessing: false }
					});

					// Update cumulative tracking
					this._requestCount++;
					if (jsonData.total_cost_usd) {
						this._totalCost += jsonData.total_cost_usd;
					}

					console.log('Result received:', {
						cost: jsonData.total_cost_usd,
						duration: jsonData.duration_ms,
						turns: jsonData.num_turns
					});

					// Send updated totals to webview
					this._postMessage({
						type: 'updateTotals',
						data: {
							totalCost: this._totalCost,
							totalTokensInput: this._totalTokensInput,
							totalTokensOutput: this._totalTokensOutput,
							requestCount: this._requestCount,
							currentCost: jsonData.total_cost_usd,
							currentDuration: jsonData.duration_ms,
							currentTurns: jsonData.num_turns
						}
					});
				}
				break;
		}
	}


	private _newSession() {

		this._isProcessing = false

		// Update UI state
		this._postMessage({
			type: 'setProcessing',
			data: { isProcessing: false }
		});

		// Try graceful termination first
		if (this._currentClaudeProcess) {
			const processToKill = this._currentClaudeProcess;
			this._currentClaudeProcess = undefined;
			processToKill.kill('SIGTERM');
		}

		// Clear current session
		this._currentSessionId = undefined;

		// Clear commits and conversation
		this._commits = [];
		this._currentConversation = [];
		this._conversationStartTime = undefined;

		// Reset counters
		this._totalCost = 0;
		this._totalTokensInput = 0;
		this._totalTokensOutput = 0;
		this._requestCount = 0;

		// Notify webview to clear all messages and reset session
		this._postMessage({
			type: 'sessionCleared'
		});
	}

	public newSessionOnConfigChange() {
		// Reinitialize MCP config with new WSL paths
		this._initializeMCPConfig();

		// Start a new session due to configuration change
		this._newSession();

		// Show notification to user
		vscode.window.showInformationMessage(
			'WSL configuration changed. Started a new Claude session.',
			'OK'
		);

		// Send message to webview about the config change
		this._sendAndSaveMessage({
			type: 'configChanged',
			data: '⚙️ WSL configuration changed. Started a new session.'
		});
	}

	private _handleLoginRequired() {

		this._isProcessing = false;

		// Clear processing state
		this._postMessage({
			type: 'setProcessing',
			data: { isProcessing: false }
		});

		// Show login required message
		this._postMessage({
			type: 'loginRequired'
		});

		// Get configuration to check if WSL is enabled
		const config = vscode.workspace.getConfiguration('claudeCodeChat');
		const wslDisabledEnv = (process.env.CLAUDE_CODE_CHAT_DISABLE_WSL || '').toLowerCase();
		const wslGloballyDisabled = wslDisabledEnv === '1' || wslDisabledEnv === 'true' || wslDisabledEnv === 'yes';
		const wslEnabled = !wslGloballyDisabled && config.get<boolean>('wsl.enabled', false);
		const wslDistro = config.get<string>('wsl.distro', 'Ubuntu');
		const nodePath = config.get<string>('wsl.nodePath', '/usr/bin/node');
		const claudePath = config.get<string>('wsl.claudePath', '/usr/local/bin/claude');

		// Open terminal and run claude login
		const terminal = vscode.window.createTerminal('Claude Login');
		if (wslEnabled) {
			terminal.sendText(`wsl -d ${wslDistro} ${nodePath} --no-warnings --enable-source-maps ${claudePath}`);
		} else {
			terminal.sendText('claude');
		}
		terminal.show();

		// Show info message
		vscode.window.showInformationMessage(
			'Please login to Claude in the terminal, then come back to this chat to continue.',
			'OK'
		);

		// Send message to UI about terminal
		this._postMessage({
			type: 'terminalOpened',
			data: `Please login to Claude in the terminal, then come back to this chat to continue.`,
		});
	}

	private async _initializeBackupRepo(): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) { return; }

			const storagePath = this._context.storageUri?.fsPath;
			if (!storagePath) {
				console.error('No workspace storage available');
				return;
			}
			console.log('Workspace storage path:', storagePath);
			this._backupRepoPath = path.join(storagePath, 'backups', '.git');

			// Create backup git directory if it doesn't exist
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(this._backupRepoPath));
			} catch {
				await vscode.workspace.fs.createDirectory(vscode.Uri.file(this._backupRepoPath));

				const workspacePath = workspaceFolder.uri.fsPath;

				// Initialize git repo with workspace as work-tree
				await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" init`);
				await exec(`git --git-dir="${this._backupRepoPath}" config user.name "Claude Code Chat"`);
				await exec(`git --git-dir="${this._backupRepoPath}" config user.email "claude@anthropic.com"`);

				console.log(`Initialized backup repository at: ${this._backupRepoPath}`);
			}
		} catch (error: any) {
			console.error('Failed to initialize backup repository:', error.message);
		}
	}

	private async _createBackupCommit(userMessage: string): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder || !this._backupRepoPath) { return; }

			const workspacePath = workspaceFolder.uri.fsPath;
			const now = new Date();
			const timestamp = now.toISOString().replace(/[:.]/g, '-');
			const displayTimestamp = now.toISOString();
			const commitMessage = `Before: ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`;

			// Add all files using git-dir and work-tree (excludes .git automatically)
			await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" add -A`);

			// Check if this is the first commit (no HEAD exists yet)
			let isFirstCommit = false;
			try {
				await exec(`git --git-dir="${this._backupRepoPath}" rev-parse HEAD`);
			} catch {
				isFirstCommit = true;
			}

			// Check if there are changes to commit
			const { stdout: status } = await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" status --porcelain`);

			// Always create a checkpoint, even if no files changed
			let actualMessage;
			if (isFirstCommit) {
				actualMessage = `Initial backup: ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`;
			} else if (status.trim()) {
				actualMessage = commitMessage;
			} else {
				actualMessage = `Checkpoint (no changes): ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`;
			}

			// Create commit with --allow-empty to ensure checkpoint is always created
			await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" commit --allow-empty -m "${actualMessage}"`);
			const { stdout: sha } = await exec(`git --git-dir="${this._backupRepoPath}" rev-parse HEAD`);

			// Store commit info
			const commitInfo = {
				id: `commit-${timestamp}`,
				sha: sha.trim(),
				message: actualMessage,
				timestamp: displayTimestamp
			};

			this._commits.push(commitInfo);

			// Show restore option in UI and save to conversation
			this._sendAndSaveMessage({
				type: 'showRestoreOption',
				data: commitInfo
			});

			console.log(`Created backup commit: ${commitInfo.sha.substring(0, 8)} - ${actualMessage}`);
		} catch (error: any) {
			console.error('Failed to create backup commit:', error.message);
		}
	}


	private async _restoreToCommit(commitSha: string): Promise<void> {
		try {
			const commit = this._commits.find(c => c.sha === commitSha);
			if (!commit) {
				this._postMessage({
					type: 'restoreError',
					data: 'Commit not found'
				});
				return;
			}

			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder || !this._backupRepoPath) {
				vscode.window.showErrorMessage('No workspace folder or backup repository available.');
				return;
			}

			const workspacePath = workspaceFolder.uri.fsPath;

			this._postMessage({
				type: 'restoreProgress',
				data: 'Restoring files from backup...'
			});

			// Restore files directly to workspace using git checkout
			await exec(`git --git-dir="${this._backupRepoPath}" --work-tree="${workspacePath}" checkout ${commitSha} -- .`);

			vscode.window.showInformationMessage(`Restored to commit: ${commit.message}`);

			this._sendAndSaveMessage({
				type: 'restoreSuccess',
				data: {
					message: `Successfully restored to: ${commit.message}`,
					commitSha: commitSha
				}
			});

		} catch (error: any) {
			console.error('Failed to restore commit:', error.message);
			vscode.window.showErrorMessage(`Failed to restore commit: ${error.message}`);
			this._postMessage({
				type: 'restoreError',
				data: `Failed to restore: ${error.message}`
			});
		}
	}

	private async _initializeConversations(): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) { return; }

			const storagePath = this._context.storageUri?.fsPath;
			if (!storagePath) { return; }

			this._conversationsPath = path.join(storagePath, 'conversations');

			// Create conversations directory if it doesn't exist
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(this._conversationsPath));
			} catch {
				await vscode.workspace.fs.createDirectory(vscode.Uri.file(this._conversationsPath));
				console.log(`Created conversations directory at: ${this._conversationsPath}`);
			}
		} catch (error: any) {
			console.error('Failed to initialize conversations directory:', error.message);
		}
	}

	private async _initializeMCPConfig(): Promise<void> {
		try {
			const storagePath = this._context.storageUri?.fsPath;
			if (!storagePath) { return; }

			// Create MCP config directory
			const mcpConfigDir = path.join(storagePath, 'mcp');
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(mcpConfigDir));
			} catch {
				await vscode.workspace.fs.createDirectory(vscode.Uri.file(mcpConfigDir));
				console.log(`Created MCP config directory at: ${mcpConfigDir}`);
			}

			// Create or update mcp-servers.json with permissions server, preserving existing servers
			const mcpConfigPath = path.join(mcpConfigDir, 'mcp-servers.json');
			const mcpPermissionsPath = this.convertToWSLPath(path.join(this._extensionUri.fsPath, 'mcp-permissions.js'));
			const permissionRequestsPath = this.convertToWSLPath(path.join(storagePath, 'permission-requests'));

			// Load existing config or create new one
			let mcpConfig: any = { mcpServers: {} };
			const mcpConfigUri = vscode.Uri.file(mcpConfigPath);

			try {
				const existingContent = await vscode.workspace.fs.readFile(mcpConfigUri);
				mcpConfig = JSON.parse(new TextDecoder().decode(existingContent));
				console.log('Loaded existing MCP config, preserving user servers');
			} catch {
				console.log('No existing MCP config found, creating new one');
			}

			// Ensure mcpServers exists
			if (!mcpConfig.mcpServers) {
				mcpConfig.mcpServers = {};
			}

			// Add or update the permissions server entry
			mcpConfig.mcpServers['claude-code-chat-permissions'] = {
				command: 'node',
				args: [mcpPermissionsPath],
				env: {
					CLAUDE_PERMISSIONS_PATH: permissionRequestsPath
				}
			};

			const configContent = new TextEncoder().encode(JSON.stringify(mcpConfig, null, 2));
			await vscode.workspace.fs.writeFile(mcpConfigUri, configContent);

			console.log(`Updated MCP config at: ${mcpConfigPath}`);
		} catch (error: any) {
			console.error('Failed to initialize MCP config:', error.message);
		}
	}

	private async _initializePermissions(): Promise<void> {
		try {

			if (this._permissionWatcher) {
				this._permissionWatcher.dispose();
				this._permissionWatcher = undefined;
			}

			const storagePath = this._context.storageUri?.fsPath;
			if (!storagePath) { return; }

			// Create permission requests directory
			this._permissionRequestsPath = path.join(path.join(storagePath, 'permission-requests'));
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(this._permissionRequestsPath));
			} catch {
				await vscode.workspace.fs.createDirectory(vscode.Uri.file(this._permissionRequestsPath));
				console.log(`Created permission requests directory at: ${this._permissionRequestsPath}`);
			}

			console.log("DIRECTORY-----", this._permissionRequestsPath)

			// Set up file watcher for *.request files
			this._permissionWatcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(this._permissionRequestsPath, '*.request')
			);

			this._permissionWatcher.onDidCreate(async (uri) => {
				// Only handle file scheme URIs, ignore vscode-userdata scheme
				if (uri.scheme === 'file') {
					await this._handlePermissionRequest(uri);
				}
			});

			this._disposables.push(this._permissionWatcher);

		} catch (error: any) {
			console.error('Failed to initialize permissions:', error.message);
		}
	}

	private async _handlePermissionRequest(requestUri: vscode.Uri): Promise<void> {
		try {
			// Read the request file
			const content = await vscode.workspace.fs.readFile(requestUri);
			const request = JSON.parse(new TextDecoder().decode(content));

			// Show permission dialog
			const approved = await this._showPermissionDialog(request);

			// Write response file
			const responseFile = requestUri.fsPath.replace('.request', '.response');
			const response = {
				id: request.id,
				approved: approved,
				timestamp: new Date().toISOString()
			};

			const responseContent = new TextEncoder().encode(JSON.stringify(response));
			await vscode.workspace.fs.writeFile(vscode.Uri.file(responseFile), responseContent);

			// Clean up request file
			await vscode.workspace.fs.delete(requestUri);

		} catch (error: any) {
			console.error('Failed to handle permission request:', error.message);
		}
	}

	private async _showPermissionDialog(request: any): Promise<boolean> {
		const toolName = request.tool || 'Unknown Tool';

		// Generate pattern for Bash commands
		let pattern = undefined;
		if (toolName === 'Bash' && request.input?.command) {
			pattern = this.getCommandPattern(request.input.command);
		}

		// Send permission request to the UI
		this._sendAndSaveMessage({
			type: 'permissionRequest',
			data: {
				id: request.id,
				tool: toolName,
				input: request.input,
				pattern: pattern
			}
		});

		// Wait for response from UI
		return new Promise((resolve) => {
			// Store the resolver so we can call it when we get the response
			this._pendingPermissionResolvers = this._pendingPermissionResolvers || new Map();
			this._pendingPermissionResolvers.set(request.id, resolve);
		});
	}

	private _handlePermissionResponse(id: string, approved: boolean, alwaysAllow?: boolean): void {
		if (this._pendingPermissionResolvers && this._pendingPermissionResolvers.has(id)) {
			const resolver = this._pendingPermissionResolvers.get(id);
			if (resolver) {
				resolver(approved);
				this._pendingPermissionResolvers.delete(id);

				// Handle always allow setting
				if (alwaysAllow && approved) {
					void this._saveAlwaysAllowPermission(id);
				}
			}
		}
	}

	private async _saveAlwaysAllowPermission(requestId: string): Promise<void> {
		try {
			// Read the original request to get tool name and input
			const storagePath = this._context.storageUri?.fsPath;
			if (!storagePath) return;

			const requestFileUri = vscode.Uri.file(path.join(storagePath, 'permission-requests', `${requestId}.request`));

			let requestContent: Uint8Array;
			try {
				requestContent = await vscode.workspace.fs.readFile(requestFileUri);
			} catch {
				return; // Request file doesn't exist
			}

			const request = JSON.parse(new TextDecoder().decode(requestContent));

			// Load existing workspace permissions
			const permissionsUri = vscode.Uri.file(path.join(storagePath, 'permission-requests', 'permissions.json'));
			let permissions: any = { alwaysAllow: {} };

			try {
				const content = await vscode.workspace.fs.readFile(permissionsUri);
				permissions = JSON.parse(new TextDecoder().decode(content));
			} catch {
				// File doesn't exist yet, use default permissions
			}

			// Add the new permission
			const toolName = request.tool;
			if (toolName === 'Bash' && request.input?.command) {
				// For Bash, store the command pattern
				if (!permissions.alwaysAllow[toolName]) {
					permissions.alwaysAllow[toolName] = [];
				}
				if (Array.isArray(permissions.alwaysAllow[toolName])) {
					const command = request.input.command.trim();
					const pattern = this.getCommandPattern(command);
					if (!permissions.alwaysAllow[toolName].includes(pattern)) {
						permissions.alwaysAllow[toolName].push(pattern);
					}
				}
			} else {
				// For other tools, allow all instances
				permissions.alwaysAllow[toolName] = true;
			}

			// Ensure permissions directory exists
			const permissionsDir = vscode.Uri.file(path.dirname(permissionsUri.fsPath));
			try {
				await vscode.workspace.fs.stat(permissionsDir);
			} catch {
				await vscode.workspace.fs.createDirectory(permissionsDir);
			}

			// Save the permissions
			const permissionsContent = new TextEncoder().encode(JSON.stringify(permissions, null, 2));
			await vscode.workspace.fs.writeFile(permissionsUri, permissionsContent);

			console.log(`Saved always-allow permission for ${toolName}`);
		} catch (error) {
			console.error('Error saving always-allow permission:', error);
		}
	}

	private getCommandPattern(command: string): string {
		const parts = command.trim().split(/\s+/);
		if (parts.length === 0) return command;

		const baseCmd = parts[0];
		const subCmd = parts.length > 1 ? parts[1] : '';

		// Common patterns that should use wildcards
		const patterns = [
			// Package managers
			['npm', 'install', 'npm install *'],
			['npm', 'i', 'npm i *'],
			['npm', 'add', 'npm add *'],
			['npm', 'remove', 'npm remove *'],
			['npm', 'uninstall', 'npm uninstall *'],
			['npm', 'update', 'npm update *'],
			['npm', 'run', 'npm run *'],
			['yarn', 'add', 'yarn add *'],
			['yarn', 'remove', 'yarn remove *'],
			['yarn', 'install', 'yarn install *'],
			['pnpm', 'install', 'pnpm install *'],
			['pnpm', 'add', 'pnpm add *'],
			['pnpm', 'remove', 'pnpm remove *'],

			// Git commands
			['git', 'add', 'git add *'],
			['git', 'commit', 'git commit *'],
			['git', 'push', 'git push *'],
			['git', 'pull', 'git pull *'],
			['git', 'checkout', 'git checkout *'],
			['git', 'branch', 'git branch *'],
			['git', 'merge', 'git merge *'],
			['git', 'clone', 'git clone *'],
			['git', 'reset', 'git reset *'],
			['git', 'rebase', 'git rebase *'],
			['git', 'tag', 'git tag *'],

			// Docker commands
			['docker', 'run', 'docker run *'],
			['docker', 'build', 'docker build *'],
			['docker', 'exec', 'docker exec *'],
			['docker', 'logs', 'docker logs *'],
			['docker', 'stop', 'docker stop *'],
			['docker', 'start', 'docker start *'],
			['docker', 'rm', 'docker rm *'],
			['docker', 'rmi', 'docker rmi *'],
			['docker', 'pull', 'docker pull *'],
			['docker', 'push', 'docker push *'],

			// Build tools
			['make', '', 'make *'],
			['cargo', 'build', 'cargo build *'],
			['cargo', 'run', 'cargo run *'],
			['cargo', 'test', 'cargo test *'],
			['cargo', 'install', 'cargo install *'],
			['mvn', 'compile', 'mvn compile *'],
			['mvn', 'test', 'mvn test *'],
			['mvn', 'package', 'mvn package *'],
			['gradle', 'build', 'gradle build *'],
			['gradle', 'test', 'gradle test *'],

			// System commands
			['curl', '', 'curl *'],
			['wget', '', 'wget *'],
			['ssh', '', 'ssh *'],
			['scp', '', 'scp *'],
			['rsync', '', 'rsync *'],
			['tar', '', 'tar *'],
			['zip', '', 'zip *'],
			['unzip', '', 'unzip *'],

			// Development tools
			['node', '', 'node *'],
			['python', '', 'python *'],
			['python3', '', 'python3 *'],
			['pip', 'install', 'pip install *'],
			['pip3', 'install', 'pip3 install *'],
			['composer', 'install', 'composer install *'],
			['composer', 'require', 'composer require *'],
			['bundle', 'install', 'bundle install *'],
			['gem', 'install', 'gem install *'],
		];

		// Find matching pattern
		for (const [cmd, sub, pattern] of patterns) {
			if (baseCmd === cmd && (sub === '' || subCmd === sub)) {
				return pattern;
			}
		}

		// Default: return exact command
		return command;
	}

	private async _sendPermissions(): Promise<void> {
		try {
			const storagePath = this._context.storageUri?.fsPath;
			if (!storagePath) {
				this._postMessage({
					type: 'permissionsData',
					data: { alwaysAllow: {} }
				});
				return;
			}

			const permissionsUri = vscode.Uri.file(path.join(storagePath, 'permission-requests', 'permissions.json'));
			let permissions: any = { alwaysAllow: {} };

			try {
				const content = await vscode.workspace.fs.readFile(permissionsUri);
				permissions = JSON.parse(new TextDecoder().decode(content));
			} catch {
				// File doesn't exist or can't be read, use default permissions
			}

			this._postMessage({
				type: 'permissionsData',
				data: permissions
			});
		} catch (error) {
			console.error('Error sending permissions:', error);
			this._postMessage({
				type: 'permissionsData',
				data: { alwaysAllow: {} }
			});
		}
	}

	private async _removePermission(toolName: string, command: string | null): Promise<void> {
		try {
			const storagePath = this._context.storageUri?.fsPath;
			if (!storagePath) return;

			const permissionsUri = vscode.Uri.file(path.join(storagePath, 'permission-requests', 'permissions.json'));
			let permissions: any = { alwaysAllow: {} };

			try {
				const content = await vscode.workspace.fs.readFile(permissionsUri);
				permissions = JSON.parse(new TextDecoder().decode(content));
			} catch {
				// File doesn't exist or can't be read, nothing to remove
				return;
			}

			// Remove the permission
			if (command === null) {
				// Remove entire tool permission
				delete permissions.alwaysAllow[toolName];
			} else {
				// Remove specific command from tool permissions
				if (Array.isArray(permissions.alwaysAllow[toolName])) {
					permissions.alwaysAllow[toolName] = permissions.alwaysAllow[toolName].filter(
						(cmd: string) => cmd !== command
					);
					// If no commands left, remove the tool entirely
					if (permissions.alwaysAllow[toolName].length === 0) {
						delete permissions.alwaysAllow[toolName];
					}
				}
			}

			// Save updated permissions
			const permissionsContent = new TextEncoder().encode(JSON.stringify(permissions, null, 2));
			await vscode.workspace.fs.writeFile(permissionsUri, permissionsContent);

			// Send updated permissions to UI
			this._sendPermissions();

			console.log(`Removed permission for ${toolName}${command ? ` command: ${command}` : ''}`);
		} catch (error) {
			console.error('Error removing permission:', error);
		}
	}

	private async _addPermission(toolName: string, command: string | null): Promise<void> {
		try {
			const storagePath = this._context.storageUri?.fsPath;
			if (!storagePath) return;

			const permissionsUri = vscode.Uri.file(path.join(storagePath, 'permission-requests', 'permissions.json'));
			let permissions: any = { alwaysAllow: {} };

			try {
				const content = await vscode.workspace.fs.readFile(permissionsUri);
				permissions = JSON.parse(new TextDecoder().decode(content));
			} catch {
				// File doesn't exist, use default permissions
			}

			// Add the new permission
			if (command === null || command === '') {
				// Allow all commands for this tool
				permissions.alwaysAllow[toolName] = true;
			} else {
				// Add specific command pattern
				if (!permissions.alwaysAllow[toolName]) {
					permissions.alwaysAllow[toolName] = [];
				}

				// Convert to array if it's currently set to true
				if (permissions.alwaysAllow[toolName] === true) {
					permissions.alwaysAllow[toolName] = [];
				}

				if (Array.isArray(permissions.alwaysAllow[toolName])) {
					// For Bash commands, convert to pattern using existing logic
					let commandToAdd = command;
					if (toolName === 'Bash') {
						commandToAdd = this.getCommandPattern(command);
					}

					// Add if not already present
					if (!permissions.alwaysAllow[toolName].includes(commandToAdd)) {
						permissions.alwaysAllow[toolName].push(commandToAdd);
					}
				}
			}

			// Ensure permissions directory exists
			const permissionsDir = vscode.Uri.file(path.dirname(permissionsUri.fsPath));
			try {
				await vscode.workspace.fs.stat(permissionsDir);
			} catch {
				await vscode.workspace.fs.createDirectory(permissionsDir);
			}

			// Save updated permissions
			const permissionsContent = new TextEncoder().encode(JSON.stringify(permissions, null, 2));
			await vscode.workspace.fs.writeFile(permissionsUri, permissionsContent);

			// Send updated permissions to UI
			this._sendPermissions();

			console.log(`Added permission for ${toolName}${command ? ` command: ${command}` : ' (all commands)'}`);
		} catch (error) {
			console.error('Error adding permission:', error);
		}
	}

	private async _loadMCPServers(): Promise<void> {
		try {
			const mcpConfigPath = this.getMCPConfigPath();
			if (!mcpConfigPath) {
				this._postMessage({ type: 'mcpServers', data: {} });
				return;
			}

			const mcpConfigUri = vscode.Uri.file(mcpConfigPath);
			let mcpConfig: any = { mcpServers: {} };

			try {
				const content = await vscode.workspace.fs.readFile(mcpConfigUri);
				mcpConfig = JSON.parse(new TextDecoder().decode(content));
			} catch (error) {
				console.log('MCP config file not found or error reading:', error);
				// File doesn't exist, return empty servers
			}

			// Filter out internal servers before sending to UI
			const filteredServers = Object.fromEntries(
				Object.entries(mcpConfig.mcpServers || {}).filter(([name]) => name !== 'claude-code-chat-permissions')
			);
			this._postMessage({ type: 'mcpServers', data: filteredServers });
		} catch (error) {
			console.error('Error loading MCP servers:', error);
			this._postMessage({ type: 'mcpServerError', data: { error: 'Failed to load MCP servers' } });
		}
	}

	private async _saveMCPServer(name: string, config: any): Promise<void> {
		try {
			const mcpConfigPath = this.getMCPConfigPath();
			if (!mcpConfigPath) {
				this._postMessage({ type: 'mcpServerError', data: { error: 'Storage path not available' } });
				return;
			}

			const mcpConfigUri = vscode.Uri.file(mcpConfigPath);
			let mcpConfig: any = { mcpServers: {} };

			// Load existing config
			try {
				const content = await vscode.workspace.fs.readFile(mcpConfigUri);
				mcpConfig = JSON.parse(new TextDecoder().decode(content));
			} catch {
				// File doesn't exist, use default structure
			}

			// Ensure mcpServers exists
			if (!mcpConfig.mcpServers) {
				mcpConfig.mcpServers = {};
			}

			// Add/update the server
			mcpConfig.mcpServers[name] = config;

			// Ensure directory exists
			const mcpDir = vscode.Uri.file(path.dirname(mcpConfigPath));
			try {
				await vscode.workspace.fs.stat(mcpDir);
			} catch {
				await vscode.workspace.fs.createDirectory(mcpDir);
			}

			// Save the config
			const configContent = new TextEncoder().encode(JSON.stringify(mcpConfig, null, 2));
			await vscode.workspace.fs.writeFile(mcpConfigUri, configContent);

			this._postMessage({ type: 'mcpServerSaved', data: { name } });
			console.log(`Saved MCP server: ${name}`);
		} catch (error) {
			console.error('Error saving MCP server:', error);
			this._postMessage({ type: 'mcpServerError', data: { error: 'Failed to save MCP server' } });
		}
	}

	private async _deleteMCPServer(name: string): Promise<void> {
		try {
			const mcpConfigPath = this.getMCPConfigPath();
			if (!mcpConfigPath) {
				this._postMessage({ type: 'mcpServerError', data: { error: 'Storage path not available' } });
				return;
			}

			const mcpConfigUri = vscode.Uri.file(mcpConfigPath);
			let mcpConfig: any = { mcpServers: {} };

			// Load existing config
			try {
				const content = await vscode.workspace.fs.readFile(mcpConfigUri);
				mcpConfig = JSON.parse(new TextDecoder().decode(content));
			} catch {
				// File doesn't exist, nothing to delete
				this._postMessage({ type: 'mcpServerError', data: { error: 'MCP config file not found' } });
				return;
			}

			// Delete the server
			if (mcpConfig.mcpServers && mcpConfig.mcpServers[name]) {
				delete mcpConfig.mcpServers[name];

				// Save the updated config
				const configContent = new TextEncoder().encode(JSON.stringify(mcpConfig, null, 2));
				await vscode.workspace.fs.writeFile(mcpConfigUri, configContent);

				this._postMessage({ type: 'mcpServerDeleted', data: { name } });
				console.log(`Deleted MCP server: ${name}`);
			} else {
				this._postMessage({ type: 'mcpServerError', data: { error: `Server '${name}' not found` } });
			}
		} catch (error) {
			console.error('Error deleting MCP server:', error);
			this._postMessage({ type: 'mcpServerError', data: { error: 'Failed to delete MCP server' } });
		}
	}

	private async _sendCustomSnippets(): Promise<void> {
		try {
			const customSnippets = this._context.globalState.get<{ [key: string]: any }>('customPromptSnippets', {});
			this._postMessage({
				type: 'customSnippetsData',
				data: customSnippets
			});
		} catch (error) {
			console.error('Error loading custom snippets:', error);
			this._postMessage({
				type: 'customSnippetsData',
				data: {}
			});
		}
	}

	private async _saveCustomSnippet(snippet: any): Promise<void> {
		try {
			const customSnippets = this._context.globalState.get<{ [key: string]: any }>('customPromptSnippets', {});
			customSnippets[snippet.id] = snippet;

			await this._context.globalState.update('customPromptSnippets', customSnippets);

			this._postMessage({
				type: 'customSnippetSaved',
				data: { snippet }
			});

			console.log('Saved custom snippet:', snippet.name);
		} catch (error) {
			console.error('Error saving custom snippet:', error);
			this._postMessage({
				type: 'error',
				data: 'Failed to save custom snippet'
			});
		}
	}

	private async _deleteCustomSnippet(snippetId: string): Promise<void> {
		try {
			const customSnippets = this._context.globalState.get<{ [key: string]: any }>('customPromptSnippets', {});

			if (customSnippets[snippetId]) {
				delete customSnippets[snippetId];
				await this._context.globalState.update('customPromptSnippets', customSnippets);

				this._postMessage({
					type: 'customSnippetDeleted',
					data: { snippetId }
				});

				console.log('Deleted custom snippet:', snippetId);
			} else {
				this._postMessage({
					type: 'error',
					data: 'Snippet not found'
				});
			}
		} catch (error) {
			console.error('Error deleting custom snippet:', error);
			this._postMessage({
				type: 'error',
				data: 'Failed to delete custom snippet'
			});
		}
	}

	private convertToWSLPath(windowsPath: string): string {
		const config = vscode.workspace.getConfiguration('claudeCodeChat');
		const wslDisabledEnv = (process.env.CLAUDE_CODE_CHAT_DISABLE_WSL || '').toLowerCase();
		const wslGloballyDisabled = wslDisabledEnv === '1' || wslDisabledEnv === 'true' || wslDisabledEnv === 'yes';
		const wslEnabled = !wslGloballyDisabled && config.get<boolean>('wsl.enabled', false);

		if (wslEnabled && windowsPath.match(/^[a-zA-Z]:/)) {
			// Convert C:\Users\... to /mnt/c/Users/...
			return windowsPath.replace(/^([a-zA-Z]):/, '/mnt/$1').toLowerCase().replace(/\\/g, '/');
		}

		return windowsPath;
	}

	public getMCPConfigPath(): string | undefined {
		const storagePath = this._context.storageUri?.fsPath;
		if (!storagePath) { return undefined; }

		const configPath = path.join(storagePath, 'mcp', 'mcp-servers.json');
		return path.join(configPath);
	}

	private _sendAndSaveMessage(message: { type: string, data: any }): void {

		// Initialize conversation if this is the first message
		if (this._currentConversation.length === 0) {
			this._conversationStartTime = new Date().toISOString();
		}

		// Send to UI using the helper method
		this._postMessage(message);

		// Save to conversation
		this._currentConversation.push({
			timestamp: new Date().toISOString(),
			messageType: message.type,
			data: message.data
		});

		// Persist conversation
		void this._saveCurrentConversation();
	}

	private async _saveCurrentConversation(): Promise<void> {
		if (!this._conversationsPath || this._currentConversation.length === 0) { return; }
		if (!this._currentSessionId) { return; }

		try {
			// Create filename from first user message and timestamp
			const firstUserMessage = this._currentConversation.find(m => m.messageType === 'userInput');
			const firstMessage = firstUserMessage ? firstUserMessage.data : 'conversation';
			const startTime = this._conversationStartTime || new Date().toISOString();
			const sessionId = this._currentSessionId || 'unknown';

			// Clean and truncate first message for filename
			const cleanMessage = firstMessage
				.replace(/[^a-zA-Z0-9\s]/g, '') // Remove special chars
				.replace(/\s+/g, '-') // Replace spaces with dashes
				.substring(0, 50) // Limit length
				.toLowerCase();

			const datePrefix = startTime.substring(0, 16).replace('T', '_').replace(/:/g, '-');
			const filename = `${datePrefix}_${cleanMessage}.json`;

			const conversationData: ConversationData = {
				sessionId: sessionId,
				startTime: this._conversationStartTime,
				endTime: new Date().toISOString(),
				messageCount: this._currentConversation.length,
				totalCost: this._totalCost,
				totalTokens: {
					input: this._totalTokensInput,
					output: this._totalTokensOutput
				},
				messages: this._currentConversation,
				filename
			};

			const filePath = path.join(this._conversationsPath, filename);
			const content = new TextEncoder().encode(JSON.stringify(conversationData, null, 2));
			await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), content);

			// Update conversation index
			this._updateConversationIndex(filename, conversationData);

			console.log(`Saved conversation: ${filename}`, this._conversationsPath);
		} catch (error: any) {
			console.error('Failed to save conversation:', error.message);
		}
	}


	public async loadConversation(filename: string): Promise<void> {
		// Load the conversation history
		await this._loadConversationHistory(filename);
	}

	private _sendConversationList(): void {
		this._postMessage({
			type: 'conversationList',
			data: this._conversationIndex
		});
	}

	private async _sendWorkspaceFiles(searchTerm?: string): Promise<void> {
		try {
			// Always get all files and filter on the backend for better search results
			const files = await vscode.workspace.findFiles(
				'**/*',
				'{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/.nuxt/**,**/target/**,**/bin/**,**/obj/**}',
				500 // Reasonable limit for filtering
			);

			let fileList = files.map(file => {
				const relativePath = vscode.workspace.asRelativePath(file);
				return {
					name: file.path.split('/').pop() || '',
					path: relativePath,
					fsPath: file.fsPath
				};
			});

			// Filter results based on search term
			if (searchTerm && searchTerm.trim()) {
				const term = searchTerm.toLowerCase();
				fileList = fileList.filter(file => {
					const fileName = file.name.toLowerCase();
					const filePath = file.path.toLowerCase();

					// Check if term matches filename or any part of the path
					return fileName.includes(term) ||
						filePath.includes(term) ||
						filePath.split('/').some(segment => segment.includes(term));
				});
			}

			// Sort and limit results
			fileList = fileList
				.sort((a, b) => a.name.localeCompare(b.name))
				.slice(0, 50);

			this._postMessage({
				type: 'workspaceFiles',
				data: fileList
			});
		} catch (error) {
			console.error('Error getting workspace files:', error);
			this._postMessage({
				type: 'workspaceFiles',
				data: []
			});
		}
	}

	private async _selectImageFile(): Promise<void> {
		try {
			// Show VS Code's native file picker for images
			const result = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: true,
				title: 'Select image files',
				filters: {
					'Images': ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']
				}
			});

			if (result && result.length > 0) {
				// Send the selected file paths back to webview
				result.forEach(uri => {
					this._postMessage({
						type: 'imagePath',
						path: uri.fsPath
					});
				});
			}

		} catch (error) {
			console.error('Error selecting image files:', error);
		}
	}

	private _stopClaudeProcess(): void {
		console.log('Stop request received');

		this._isProcessing = false

		// Update UI state
		this._postMessage({
			type: 'setProcessing',
			data: { isProcessing: false }
		});

		if (this._currentClaudeProcess) {
			console.log('Terminating Claude process...');

			// Try graceful termination first
			this._currentClaudeProcess.kill('SIGTERM');

			// Force kill after 2 seconds if still running
			setTimeout(() => {
				if (this._currentClaudeProcess && !this._currentClaudeProcess.killed) {
					console.log('Force killing Claude process...');
					this._currentClaudeProcess.kill('SIGKILL');
				}
			}, 2000);

			// Clear process reference
			this._currentClaudeProcess = undefined;

			this._postMessage({
				type: 'clearLoading'
			});

			// Send stop confirmation message directly to UI and save
			this._sendAndSaveMessage({
				type: 'error',
				data: '⏹️ Claude code was stopped.'
			});

			console.log('Claude process termination initiated');
		} else {
			console.log('No Claude process running to stop');
		}
	}

	private _updateConversationIndex(filename: string, conversationData: ConversationData): void {
		// Extract first and last user messages
		const userMessages = conversationData.messages.filter((m: any) => m.messageType === 'userInput');
		const firstUserMessage = userMessages.length > 0 ? userMessages[0].data : 'No user message';
		const lastUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1].data : firstUserMessage;

		// Create or update index entry
		const indexEntry = {
			filename: filename,
			sessionId: conversationData.sessionId,
			startTime: conversationData.startTime || '',
			endTime: conversationData.endTime,
			messageCount: conversationData.messageCount,
			totalCost: conversationData.totalCost,
			firstUserMessage: firstUserMessage.substring(0, 100), // Truncate for storage
			lastUserMessage: lastUserMessage.substring(0, 100)
		};

		// Remove any existing entry for this session (in case of updates)
		this._conversationIndex = this._conversationIndex.filter(entry => entry.filename !== conversationData.filename);

		// Add new entry at the beginning (most recent first)
		this._conversationIndex.unshift(indexEntry);

		// Keep only last 50 conversations to avoid workspace state bloat
		if (this._conversationIndex.length > 50) {
			this._conversationIndex = this._conversationIndex.slice(0, 50);
		}

		// Save to workspace state
		this._context.workspaceState.update('claude.conversationIndex', this._conversationIndex);
	}

	private _getLatestConversation(): any | undefined {
		return this._conversationIndex.length > 0 ? this._conversationIndex[0] : undefined;
	}

	private async _loadConversationHistory(filename: string): Promise<void> {
		console.log("_loadConversationHistory");
		if (!this._conversationsPath) { return; }

		try {
			const filePath = path.join(this._conversationsPath, filename);
			console.log("filePath", filePath);

			let conversationData: ConversationData;
			try {
				const fileUri = vscode.Uri.file(filePath);
				const content = await vscode.workspace.fs.readFile(fileUri);
				conversationData = JSON.parse(new TextDecoder().decode(content));
			} catch {
				return;
			}

			// Load conversation into current state
			this._currentConversation = conversationData.messages || [];
			this._conversationStartTime = conversationData.startTime;
			this._totalCost = conversationData.totalCost || 0;
			this._totalTokensInput = conversationData.totalTokens?.input || 0;
			this._totalTokensOutput = conversationData.totalTokens?.output || 0;

			// Clear UI messages first, then send all messages to recreate the conversation
			setTimeout(() => {
				// Clear existing messages
				this._postMessage({
					type: 'sessionCleared'
				});

				let requestStartTime: number

				// Small delay to ensure messages are cleared before loading new ones
				setTimeout(() => {
					const messages = this._currentConversation;
					for (let i = 0; i < messages.length; i++) {

						const message = messages[i];

						if(message.messageType === 'permissionRequest'){
							const isLast = i === messages.length - 1;
							if(!isLast){
								continue;
							}
						}

						this._postMessage({
							type: message.messageType,
							data: message.data
						});
						if (message.messageType === 'userInput') {
							try {
								requestStartTime = new Date(message.timestamp).getTime()
							} catch (e) {
								console.log(e)
							}
						}
					}

					// Send updated totals
					this._postMessage({
						type: 'updateTotals',
						data: {
							totalCost: this._totalCost,
							totalTokensInput: this._totalTokensInput,
							totalTokensOutput: this._totalTokensOutput,
							requestCount: this._requestCount
						}
					});

					// Restore processing state if the conversation was saved while processing
					if (this._isProcessing) {
						this._postMessage({
							type: 'setProcessing',
							data: { isProcessing: this._isProcessing, requestStartTime }
						});
					}
					// Send ready message after conversation is loaded
					this._sendReadyMessage();
				}, 50);
			}, 100); // Small delay to ensure webview is ready

			console.log(`Loaded conversation history: ${filename}`);
		} catch (error: any) {
			console.error('Failed to load conversation history:', error.message);
		}
	}

	private _getHtmlForWebview(): string {
		return getHtml(vscode.env?.isTelemetryEnabled);
	}

	private _sendCurrentSettings(): void {
		const config = vscode.workspace.getConfiguration('claudeCodeChat');
		const settings = {
			'thinking.intensity': config.get<string>('thinking.intensity', 'think'),
			'wsl.enabled': config.get<boolean>('wsl.enabled', false),
			'wsl.distro': config.get<string>('wsl.distro', 'Ubuntu'),
			'wsl.nodePath': config.get<string>('wsl.nodePath', '/usr/bin/node'),
			'wsl.claudePath': config.get<string>('wsl.claudePath', '/usr/local/bin/claude'),
			'permissions.yoloMode': config.get<boolean>('permissions.yoloMode', false)
		};

		this._postMessage({
			type: 'settingsData',
			data: settings
		});
	}

	private async _enableYoloMode(): Promise<void> {
		try {
			// Update VS Code configuration to enable YOLO mode
			const config = vscode.workspace.getConfiguration('claudeCodeChat');

			// Clear any global setting and set workspace setting
			await config.update('permissions.yoloMode', true, vscode.ConfigurationTarget.Workspace);

			console.log('YOLO Mode enabled - all future permissions will be skipped');

			// Send updated settings to UI
			this._sendCurrentSettings();

		} catch (error) {
			console.error('Error enabling YOLO mode:', error);
		}
	}

	private _saveInputText(text: string): void {
		this._draftMessage = text || '';
	}

	private async _updateSettings(settings: { [key: string]: any }): Promise<void> {
		const config = vscode.workspace.getConfiguration('claudeCodeChat');

		try {
			for (const [key, value] of Object.entries(settings)) {
				if (key === 'permissions.yoloMode') {
					// YOLO mode is workspace-specific
					await config.update(key, value, vscode.ConfigurationTarget.Workspace);
				} else {
					// Other settings are global (user-wide)
					await config.update(key, value, vscode.ConfigurationTarget.Global);
				}
			}

			console.log('Settings updated:', settings);
		} catch (error) {
			console.error('Failed to update settings:', error);
			vscode.window.showErrorMessage('Failed to update settings');
		}
	}

	private async _getClipboardText(): Promise<void> {
		try {
			const text = await vscode.env.clipboard.readText();
			this._postMessage({
				type: 'clipboardText',
				data: text
			});
		} catch (error) {
			console.error('Failed to read clipboard:', error);
		}
	}

	private _setSelectedModel(model: string): void {
		// Validate model name to prevent issues mentioned in the GitHub issue
		const validModels = ['opus', 'sonnet', 'default'];
		if (validModels.includes(model)) {
			this._selectedModel = model;
			console.log('Model selected:', model);

			// Store the model preference in workspace state
			this._context.workspaceState.update('claude.selectedModel', model);

			// Show confirmation
			vscode.window.showInformationMessage(`Claude model switched to: ${model.charAt(0).toUpperCase() + model.slice(1)}`);
		} else {
			console.error('Invalid model selected:', model);
			vscode.window.showErrorMessage(`Invalid model: ${model}. Please select Opus, Sonnet, or Default.`);
		}
	}

	private _openModelTerminal(): void {
		const config = vscode.workspace.getConfiguration('claudeCodeChat');
		const wslDisabledEnv = (process.env.CLAUDE_CODE_CHAT_DISABLE_WSL || '').toLowerCase();
		const wslGloballyDisabled = wslDisabledEnv === '1' || wslDisabledEnv === 'true' || wslDisabledEnv === 'yes';
		const wslEnabled = !wslGloballyDisabled && config.get<boolean>('wsl.enabled', false);
		const wslDistro = config.get<string>('wsl.distro', 'Ubuntu');
		const nodePath = config.get<string>('wsl.nodePath', '/usr/bin/node');
		const claudePath = config.get<string>('wsl.claudePath', '/usr/local/bin/claude');

		// Build command arguments
		const args = ['/model'];

		// Add session resume if we have a current session
		if (this._currentSessionId) {
			args.push('--resume', this._currentSessionId);
		}

		// Create terminal with the claude /model command
		const terminal = vscode.window.createTerminal('Claude Model Selection');
		// Include CLAUDE_CONFIG_DIR so terminal uses same instance/session store
		const configDir = this._getClaudeConfigDir();
		const envPrefix = configDir ? `CLAUDE_CONFIG_DIR="${configDir}" ` : '';
		if (wslEnabled) {
			terminal.sendText(`wsl -d ${wslDistro} ${nodePath} --no-warnings --enable-source-maps ${claudePath} ${args.join(' ')}`);
		} else {
			terminal.sendText(`${envPrefix}claude ${args.join(' ')}`.trim());
		}
		terminal.show();

		// Show info message
		vscode.window.showInformationMessage(
			'Check the terminal to update your default model configuration. Come back to this chat here after making changes.',
			'OK'
		);

		// Send message to UI about terminal
		this._postMessage({
			type: 'terminalOpened',
			data: 'Check the terminal to update your default model configuration. Come back to this chat here after making changes.'
		});
	}

	private _executeSlashCommand(command: string): void {
		const config = vscode.workspace.getConfiguration('claudeCodeChat');
		const wslDisabledEnv = (process.env.CLAUDE_CODE_CHAT_DISABLE_WSL || '').toLowerCase();
		const wslGloballyDisabled = wslDisabledEnv === '1' || wslDisabledEnv === 'true' || wslDisabledEnv === 'yes';
		const wslEnabled = !wslGloballyDisabled && config.get<boolean>('wsl.enabled', false);
		const wslDistro = config.get<string>('wsl.distro', 'Ubuntu');
		const nodePath = config.get<string>('wsl.nodePath', '/usr/bin/node');
		const claudePath = config.get<string>('wsl.claudePath', '/usr/local/bin/claude');

		// Build command arguments
		const args = [`/${command}`];

		// Respect YOLO mode for slash commands: skip permission prompts when enabled
		const yoloMode = config.get<boolean>('permissions.yoloMode', false);
		if (yoloMode) {
			args.push('--dangerously-skip-permissions');
		}

		// Add session resume if we have a current session
		if (this._currentSessionId) {
			args.push('--resume', this._currentSessionId);
		}

		// Create terminal with the claude command
		const terminal = vscode.window.createTerminal(`Claude /${command}`);
		// Include CLAUDE_CONFIG_DIR so terminal uses same instance/session store
		const configDir = this._getClaudeConfigDir();
		const envPrefix = configDir ? `CLAUDE_CONFIG_DIR="${configDir}" ` : '';
		if (wslEnabled) {
			terminal.sendText(`wsl -d ${wslDistro} ${nodePath} --no-warnings --enable-source-maps ${claudePath} ${args.join(' ')}`);
		} else {
			terminal.sendText(`${envPrefix}claude ${args.join(' ')}`.trim());
		}
		terminal.show();

		// Show info message
		vscode.window.showInformationMessage(
			`Executing /${command} command in terminal. Check the terminal output and return when ready.`,
			'OK'
		);

		// Send message to UI about terminal
		this._postMessage({
			type: 'terminalOpened',
			data: `Executing /${command} command in terminal. Check the terminal output and return when ready.`,
		});
	}

	private _sendPlatformInfo() {
		const platform = process.platform;
		const dismissed = this._context.globalState.get<boolean>('wslAlertDismissed', false);

		// Get WSL configuration
		const config = vscode.workspace.getConfiguration('claudeCodeChat');
		const wslDisabledEnv = (process.env.CLAUDE_CODE_CHAT_DISABLE_WSL || '').toLowerCase();
		const wslGloballyDisabled = wslDisabledEnv === '1' || wslDisabledEnv === 'true' || wslDisabledEnv === 'yes';
		const wslEnabled = !wslGloballyDisabled && config.get<boolean>('wsl.enabled', false);

		this._postMessage({
			type: 'platformInfo',
			data: {
				platform: platform,
				isWindows: platform === 'win32',
				wslAlertDismissed: dismissed,
				wslEnabled: wslEnabled
			}
		});
	}

	private _dismissWSLAlert() {
		this._context.globalState.update('wslAlertDismissed', true);
	}

	private async _openFileInEditor(filePath: string) {
		try {
			const uri = vscode.Uri.file(filePath);
			const document = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
			console.error('Error opening file:', error);
		}
	}

	private async _createImageFile(imageData: string, imageType: string) {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) { return; }

			// Extract base64 data from data URL
			const base64Data = imageData.split(',')[1];
			const buffer = Buffer.from(base64Data, 'base64');

			// Get file extension from image type
			const extension = imageType.split('/')[1] || 'png';

			// Create unique filename with timestamp
			const timestamp = Date.now();
			const imageFileName = `image_${timestamp}.${extension}`;

			// Create images folder in workspace .claude directory
			const imagesDir = vscode.Uri.joinPath(workspaceFolder.uri, '.claude', 'claude-code-chat-images');
			await vscode.workspace.fs.createDirectory(imagesDir);

			// Create .gitignore to ignore all images
			const gitignorePath = vscode.Uri.joinPath(imagesDir, '.gitignore');
			try {
				await vscode.workspace.fs.stat(gitignorePath);
			} catch {
				// .gitignore doesn't exist, create it
				const gitignoreContent = new TextEncoder().encode('*\n');
				await vscode.workspace.fs.writeFile(gitignorePath, gitignoreContent);
			}

			// Create the image file
			const imagePath = vscode.Uri.joinPath(imagesDir, imageFileName);
			await vscode.workspace.fs.writeFile(imagePath, buffer);

			// Send the file path back to webview
			this._postMessage({
				type: 'imagePath',
				data: {
					filePath: imagePath.fsPath
				}
			});

		} catch (error) {
			console.error('Error creating image file:', error);
			vscode.window.showErrorMessage('Failed to create image file');
		}
	}

	// ============================================
	// CLAUDE INSTANCE MANAGEMENT
	// ============================================

	/**
	 * Detects all available Claude instances by scanning home directory.
	 * Implements robust detection with symlink resolution and validation.
	 */
	private _detectClaudeInstances(): Array<{
		name: string;
		displayName: string;
		path: string;
		flags: string[];
		isValid: boolean;
	}> {
		const instances: Array<{
			name: string;
			displayName: string;
			path: string;
			flags: string[];
			isValid: boolean;
		}> = [];

		// Always include default instance
		instances.push({
			name: 'default',
			displayName: 'Default',
			path: '',
			flags: [],
			isValid: true
		});

		try {
			const homeDir = process.env.HOME || process.env.USERPROFILE;
			if (!homeDir) {
				console.warn('Could not determine home directory');
				return instances;
			}

			// Get config to check if WSL is enabled
			const config = vscode.workspace.getConfiguration('claudeCodeChat');
			const wslDisabledEnv = (process.env.CLAUDE_CODE_CHAT_DISABLE_WSL || '').toLowerCase();
		const wslGloballyDisabled = wslDisabledEnv === '1' || wslDisabledEnv === 'true' || wslDisabledEnv === 'yes';
		const wslEnabled = !wslGloballyDisabled && config.get<boolean>('wsl.enabled', false);

			// Scan for .claude* directories
			const files = require('fs').readdirSync(homeDir);

			for (const file of files) {
				// Skip if not starting with .claude
				if (!file.startsWith('.claude')) {
					continue;
				}

				const fullPath = path.join(homeDir, file);

				try {
					// Check if it's a directory (and resolve symlinks)
					const stats = require('fs').lstatSync(fullPath);
					if (!stats.isDirectory() && !stats.isSymbolicLink()) {
						continue;
					}

					// Resolve symlinks to real path
					const realPath = require('fs').realpathSync(fullPath);

					// Check if directory is valid (has expected structure)
					const isValid = this._validateClaudeDirectory(realPath);

					// Determine display name and flags
					let displayName = file.replace('.claude-', '').replace('.claude', 'Default');
					let flags: string[] = [];

					// Special handling for known instances
					if (file === '.claude') {
						displayName = 'Default';
					} else if (file === '.claude-codex') {
						displayName = 'Codex';
						flags = ['--dangerously-skip-permissions'];
					} else if (file === '.claude-gpt5') {
						displayName = 'GPT-5';
						flags = ['--dangerously-skip-permissions'];
					} else if (file === '.claude-sonnet') {
						displayName = 'Sonnet';
						flags = ['--dangerously-skip-permissions'];
					} else {
						// Capitalize first letter
						displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1);
					}

					// Add instance (skip default as it's already added)
					if (file !== '.claude') {
						instances.push({
							name: file,
							displayName,
							path: wslEnabled ? this.convertToWSLPath(realPath) : realPath,
							flags,
							isValid
						});
					} else {
						// Update default instance with real path
						instances[0].path = wslEnabled ? this.convertToWSLPath(realPath) : realPath;
						instances[0].isValid = isValid;
					}

				} catch (error: any) {
					// Permission error or symlink resolution error
					console.warn(`Could not access ${file}:`, error.message);

					// Still add it but mark as invalid
					instances.push({
						name: file,
						displayName: file.replace('.claude-', '').replace('.claude', 'Default'),
						path: fullPath,
						flags: [],
						isValid: false
					});
				}
			}

			// Sort instances: default first, then by name
			instances.sort((a, b) => {
				if (a.name === 'default') return -1;
				if (b.name === 'default') return 1;
				return a.displayName.localeCompare(b.displayName);
			});

			console.log('Detected Claude instances:', instances);
			return instances;

		} catch (error: any) {
			console.error('Error detecting Claude instances:', error);
			return instances; // Return at least default
		}
	}

	/**
	 * Validates if a directory is a valid Claude configuration directory.
	 */
	private _validateClaudeDirectory(dirPath: string): boolean {
		try {
			const fs = require('fs');

			// Check for presence of typical Claude files
			const expectedFiles = ['settings.json', 'history.jsonl', '.credentials.json'];

			// At least one of these should exist
			return expectedFiles.some(file => {
				try {
					return fs.existsSync(path.join(dirPath, file));
				} catch {
					return false;
				}
			});
		} catch {
			return false;
		}
	}

	/**
	 * Loads the selected instance with dual persistence (workspace + global fallback).
	 */
	private _loadSelectedInstance(): string {
		// Try workspace-specific preference first
		const workspaceInstance = this._context.workspaceState.get<string>('claude.selectedInstance');

		if (workspaceInstance) {
			// Validate that the instance still exists
			const exists = this._availableInstances.some(i => i.name === workspaceInstance);
			if (exists) {
				console.log('Loaded workspace instance:', workspaceInstance);
				return workspaceInstance;
			} else {
				console.warn(`Workspace instance ${workspaceInstance} no longer exists, purging`);
				this._context.workspaceState.update('claude.selectedInstance', undefined);
			}
		}

		// Fallback to global preference
		const globalInstance = this._context.globalState.get<string>('claude.selectedInstance', 'default');

		// Validate global preference
		const exists = this._availableInstances.some(i => i.name === globalInstance);
		if (exists) {
			console.log('Using global instance:', globalInstance);
			return globalInstance;
		}

		console.log('Using default instance');
		return 'default';
	}

	/**
	 * Sets the selected Claude instance with validation and persistence.
	 */
	private _setSelectedInstance(instanceName: string, useGlobally: boolean = false): void {
		// Re-detect instances to ensure up-to-date list
		this._availableInstances = this._detectClaudeInstances();

		// Find the instance
		const instance = this._availableInstances.find(i => i.name === instanceName);

		if (!instance) {
			vscode.window.showErrorMessage(`Instance '${instanceName}' not found`);
			return;
		}

		if (!instance.isValid) {
			vscode.window.showWarningMessage(
				`Instance '${instance.displayName}' may not be properly configured. Use anyway?`,
				'Use Anyway',
				'Cancel'
			).then(choice => {
				if (choice === 'Use Anyway') {
					this._applyInstanceSelection(instanceName, useGlobally);
				}
			});
			return;
		}

		this._applyInstanceSelection(instanceName, useGlobally);
	}

	/**
	 * Applies the instance selection (after validation).
	 */
	private _applyInstanceSelection(instanceName: string, useGlobally: boolean): void {
		const instance = this._availableInstances.find(i => i.name === instanceName);
		if (!instance) return;

		// Check if there's an active process
		if (this._currentClaudeProcess) {
			vscode.window.showWarningMessage(
				`Switching to '${instance.displayName}' will restart the current session. Continue?`,
				'Restart Now',
				'Cancel'
			).then(choice => {
				if (choice === 'Restart Now') {
					this._stopClaudeProcess();
					this._finalizeInstanceSelection(instanceName, instance, useGlobally);
				}
			});
			return;
		}

		this._finalizeInstanceSelection(instanceName, instance, useGlobally);
	}

	/**
	 * Finalizes the instance selection (saves and notifies).
	 */
	private _finalizeInstanceSelection(instanceName: string, instance: any, useGlobally: boolean): void {
		this._selectedInstance = instanceName;

		// Save to workspace state
		this._context.workspaceState.update('claude.selectedInstance', instanceName);

		// Optionally save to global state
		if (useGlobally) {
			this._context.globalState.update('claude.selectedInstance', instanceName);
		}

		// Invalidate current session (force new session on next message)
		this._currentSessionId = undefined;

		console.log('Instance selected:', instanceName);

		// Show confirmation
		const scope = useGlobally ? ' (for all workspaces)' : '';
		vscode.window.showInformationMessage(
			`Claude instance switched to: ${instance.displayName}${scope}`
		);

		// Notify frontend
		this._postMessage({
			type: 'instanceChanged',
			data: {
				name: instanceName,
				displayName: instance.displayName
			}
		});
	}

	/**
	 * Sends available instances to the frontend.
	 */
	private _sendAvailableInstances(): void {
		// Re-scan before sending
		this._availableInstances = this._detectClaudeInstances();

		this._postMessage({
			type: 'instancesData',
			data: {
				available: this._availableInstances,
				selected: this._selectedInstance
			}
		});
	}

	/**
	 * Gets the CLAUDE_CONFIG_DIR for spawn, with WSL path conversion.
	 * This is "frozen" during spawn to avoid race conditions.
	 */
	private _getClaudeConfigDir(): string {
		// Revalidate the selected instance before spawn
		const instance = this._availableInstances.find(i => i.name === this._selectedInstance);

		if (!instance) {
			console.warn(`Selected instance ${this._selectedInstance} not found, using default`);
			return '';
		}

		if (!instance.isValid) {
			console.warn(`Selected instance ${this._selectedInstance} is not valid, using default`);
			return '';
		}

		if (instance.name === 'default') {
			return ''; // No override needed
		}

		// Return the pre-converted path (already converted to WSL if needed)
		return instance.path;
	}

	/**
	 * Start polling for indexing status updates from .codebase/state.json
	 */
	private _startIndexingStatusPolling(): void {
		// Stop any existing polling
		this._stopIndexingStatusPolling();

		// Send initial status
		this._checkIndexingStatus();

		// Poll every 3 seconds
		this._indexingStatusInterval = setInterval(() => {
			this._checkIndexingStatus();
		}, 3000);
	}

	/**
	 * Stop indexing status polling
	 */
	private _stopIndexingStatusPolling(): void {
		if (this._indexingStatusInterval) {
			clearInterval(this._indexingStatusInterval);
			this._indexingStatusInterval = undefined;
		}
	}

	/**
	 * Check indexing status from .codebase/state.json and send to frontend
	 */
	private _checkIndexingStatus(): void {
		if (!this._codebaseStatePath) {
			// No workspace or no state path configured
			this._postMessage({
				type: 'indexingStatus',
				data: {
					state: 'not-found',
					message: 'No workspace detected'
				}
			});
			return;
		}

		const fs = require('fs');

		try {
			// Check if file exists
			if (!fs.existsSync(this._codebaseStatePath)) {
				this._postMessage({
					type: 'indexingStatus',
					data: {
						state: 'not-found',
						message: 'Codebase not indexed yet'
					}
				});
				return;
			}

			// Read and parse state.json
			const stateContent = fs.readFileSync(this._codebaseStatePath, 'utf-8');
			const state = JSON.parse(stateContent);

			// Extract relevant info
			const indexingState = state.indexingStatus?.state || 'unknown';
			const qdrantStats = state.qdrantStats || {};
			const lastActivity = state.lastActivity || {};

			// Only send update if state changed
			if (indexingState !== this._lastIndexingState) {
				this._lastIndexingState = indexingState;

				this._postMessage({
					type: 'indexingStatus',
					data: {
						state: indexingState,
						totalVectors: qdrantStats.totalVectors || 0,
						uniqueFiles: qdrantStats.uniqueFiles || 0,
						lastActivity: lastActivity.action || '',
						lastFile: lastActivity.filePath || '',
						qdrantCollection: state.qdrantCollection || '',
						message: this._getIndexingMessage(indexingState, qdrantStats)
					}
				});
			}
		} catch (error: any) {
			console.error('Error reading codebase state:', error);
			this._postMessage({
				type: 'indexingStatus',
				data: {
					state: 'error',
					message: `Error: ${error.message}`
				}
			});
		}
	}

	/**
	 * Get user-friendly message for indexing state
	 */
	private _getIndexingMessage(state: string, stats: any): string {
		switch (state) {
			case 'watching':
				return `Indexed: ${stats.totalVectors || 0} vectors, ${stats.uniqueFiles || 0} files`;
			case 'indexing':
				return `Indexing in progress... ${stats.uniqueFiles || 0} files so far`;
			case 'idle':
				return `Idle: ${stats.totalVectors || 0} vectors indexed`;
			case 'error':
				return 'Indexing error occurred';
			default:
				return `Status: ${state}`;
		}
	}

	// ================================
	// Codebase CLI integration
	// ================================
	public async startCodebaseWatcher(): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) return;
			const workspacePath = workspaceFolder.uri.fsPath;
			const codebaseCmd = await this._resolveCodebasePath();
			if (!codebaseCmd) {
				this._output.appendLine('Codebase CLI not found; skipping auto-start');
				return;
			}
			await this._runCodebase(['-start', workspacePath]);
			this._output.appendLine(`codebase -start initiated for ${workspacePath}`);
		} catch (err: any) {
			this._output.appendLine(`Failed to start codebase watcher: ${err.message || err}`);
		}
	}

	public async stopCodebaseWatcher(): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) return;
			const workspacePath = workspaceFolder.uri.fsPath;
			await this._runCodebase(['-stop', workspacePath]);
			this._output.appendLine(`codebase -stop requested for ${workspacePath}`);
		} catch (err: any) {
			this._output.appendLine(`Failed to stop codebase watcher: ${err.message || err}`);
		}
	}

	public stopCodebaseWatcherSync(): void {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) return;
			const workspacePath = workspaceFolder.uri.fsPath;
			let codebaseCmd = this._codebasePathCache;
			if (!codebaseCmd) {
				try {
					codebaseCmd = cp.execSync('which codebase', { encoding: 'utf8' }).trim();
				} catch {
					codebaseCmd = path.join(process.env.HOME || '', '.local', 'bin', 'codebase');
				}
				this._codebasePathCache = codebaseCmd;
			}
			const config = vscode.workspace.getConfiguration('claudeCodeChat');
			const wslDisabledEnv = (process.env.CLAUDE_CODE_CHAT_DISABLE_WSL || '').toLowerCase();
			const wslGloballyDisabled = wslDisabledEnv === '1' || wslDisabledEnv === 'true' || wslDisabledEnv === 'yes';
			const wslEnabled = !wslGloballyDisabled && config.get<boolean>('wsl.enabled', false);
			const wslDistro = config.get<string>('wsl.distro', 'Ubuntu');

			if (wslEnabled && process.platform === 'win32') {
				const cmd = `"${codebaseCmd}" '-stop' '${workspacePath.replace(/'/g, "'\\\''")}'`;
				cp.spawnSync('wsl', ['-d', wslDistro, 'bash', '-ic', cmd], { stdio: 'ignore' });
			} else {
				cp.spawnSync(codebaseCmd, ['-stop', workspacePath], { stdio: 'ignore' });
			}
			this._output.appendLine(`codebase -stop sync requested for ${workspacePath}`);
		} catch (err: any) {
			this._output.appendLine(`Failed to stop codebase watcher (sync): ${err.message || err}`);
		}
	}

	private async _handleCodebaseCommand(cmd: string): Promise<void> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const workspacePath = workspaceFolder?.uri.fsPath;
		switch (cmd) {
			case 'start':
				if (!workspacePath) return;
				await this._runCodebase(['-start', workspacePath]);
				break;
			case 'stop':
				if (!workspacePath) return;
				await this._runCodebase(['-stop', workspacePath]);
				break;
			case 'stats':
				await this._runCodebase(['-stats']);
				break;
			case 'index-history':
				await this._runCodebase(['-index-history']);
				break;
			case 'full-reset':
				if (!workspacePath) return;
				const confirm = await vscode.window.showWarningMessage('This will reset the index for this workspace. Continue?', 'Yes', 'No');
				if (confirm !== 'Yes') return;
				await this._runCodebase(['-full-reset', workspacePath]);
				break;
		}
	}

	private async _resolveCodebasePath(): Promise<string | undefined> {
		if (this._codebasePathCache) return this._codebasePathCache;
		const config = vscode.workspace.getConfiguration('claudeCodeChat');
		const configured = config.get<string>('codebase.path');
		if (configured) {
			this._codebasePathCache = configured;
			return configured;
		}
		// Try PATH
		try {
			const { stdout } = await exec('which codebase');
			const found = stdout.trim();
			if (found) {
				this._codebasePathCache = found;
				return found;
			}
		} catch {}
		// Fallback to common location
		const fallback = path.join(process.env.HOME || '', '.local', 'bin', 'codebase');
		this._codebasePathCache = fallback;
		return fallback;
	}

	private async _runCodebase(args: string[]): Promise<void> {
		const codebaseCmd = await this._resolveCodebasePath();
		if (!codebaseCmd) {
			vscode.window.showWarningMessage('Codebase CLI not found. Configure claudeCodeChat.codebase.path');
			return;
		}
		const config = vscode.workspace.getConfiguration('claudeCodeChat');
		const wslDisabledEnv = (process.env.CLAUDE_CODE_CHAT_DISABLE_WSL || '').toLowerCase();
		const wslGloballyDisabled = wslDisabledEnv === '1' || wslDisabledEnv === 'true' || wslDisabledEnv === 'yes';
		const wslEnabled = !wslGloballyDisabled && config.get<boolean>('wsl.enabled', false);
		const wslDistro = config.get<string>('wsl.distro', 'Ubuntu');

		if (wslEnabled && process.platform === 'win32') {
			const cmd = `"${codebaseCmd}" ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;
			const terminal = vscode.window.createTerminal('Codebase');
			terminal.sendText(`wsl -d ${wslDistro} bash -ic ${JSON.stringify(cmd)}`);
			terminal.show();
			return;
		}
		// Run detached in background when starting watcher; others open terminal
		if (args[0] === '-start') {
			cp.spawn(codebaseCmd, args, { detached: true, stdio: 'ignore' }).unref();
			return;
		}
		const terminal = vscode.window.createTerminal('Codebase');
		terminal.sendText(`${codebaseCmd} ${args.join(' ')}`);
		terminal.show();
	}

	public dispose() {
		if (this._panel) {
			this._panel.dispose();
			this._panel = undefined;
		}

		// Dispose message handler if it exists
		if (this._messageHandlerDisposable) {
			this._messageHandlerDisposable.dispose();
			this._messageHandlerDisposable = undefined;
		}

		// Stop indexing status polling
		this._stopIndexingStatusPolling();

		while (this._disposables.length) {
			const disposable = this._disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}
	}
}