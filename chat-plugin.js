/**
 * SGSK LiveChat Plugin - Enhanced Version with Auto-Launcher
 * 
 * Usage: <script src="https://sgskeseva.com/api/v1/plugin/chat.js"></script>
 * 
 * Features:
 * - One-line installation
 * - Auto-launch on operator messages
 * - Configurable branding
 * - Mobile responsive
 * - Analytics tracking
 */

(function() {
    'use strict';
    
    // Default configuration
    const defaultConfig = {
        partnerId: null,
        apiEndpoint: 'https://sgskeseva.com/api/v1',
        websocketUrl: 'wss://chat.sgskeseva.com',
        theme: 'light',
        position: 'bottom-right',
        welcomeMessage: 'Hello! How can we help you today?',
        autoLaunch: true,
        autoLaunchDelay: 2000, // ms
        showBranding: true,
        branding: {
            primaryColor: '#667eea',
            secondaryColor: '#764ba2',
            logoUrl: null,
            companyName: 'Support'
        },
        analytics: true
    };
    
    // State
    let socket = null;
    let isConnected = false;
    let config = {};
    let chatWindow = null;
    let chatMessages = null;
    let chatInput = null;
    let chatForm = null;
    let sessionToken = null;
    let userData = null;
    
    // Get configuration
    function getConfig() {
        const windowConfig = window.SGSKChatConfig || {};
        const scriptTag = document.currentScript || document.querySelector('script[src*="chat.js"]');
        const dataConfig = {};
        
        if (scriptTag) {
            dataConfig.partnerId = scriptTag.getAttribute('data-partner-id');
            dataConfig.theme = scriptTag.getAttribute('data-theme');
            dataConfig.position = scriptTag.getAttribute('data-position');
            dataConfig.welcomeMessage = scriptTag.getAttribute('data-welcome-message');
            dataConfig.autoLaunch = scriptTag.getAttribute('data-auto-launch') !== 'false';
            dataConfig.primaryColor = scriptTag.getAttribute('data-primary-color');
        }
        
        return { ...defaultConfig, ...windowConfig, ...dataConfig };
    }
    
    // Create chat widget
    function createWidget(config) {
        const widget = document.createElement('div');
        widget.id = 'sgsk-chat-widget';
        
        const isLeft = config.position === 'bottom-left';
        
        widget.innerHTML = `
            <!-- Chat Button -->
            <div id="sgsk-chat-button" style="
                position: fixed;
                bottom: 20px;
                ${isLeft ? 'left' : 'right'}: 20px;
                z-index: 999999;
                cursor: pointer;
                transition: transform 0.2s;
            " onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
                <div style="
                    width: 60px;
                    height: 60px;
                    background: linear-gradient(135deg, ${config.branding.primaryColor}, ${config.branding.secondaryColor});
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                ">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                </div>
                <div id="sgsk-unread-badge" style="
                    display: none;
                    position: absolute;
                    top: -5px;
                    ${isLeft ? 'right' : 'left'}: -5px;
                    background: #ef4444;
                    color: white;
                    border-radius: 50%;
                    width: 24px;
                    height: 24px;
                    font-size: 12px;
                    font-weight: bold;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                ">0</div>
            </div>
            
            <!-- Chat Window -->
            <div id="sgsk-chat-window" style="
                display: none;
                position: fixed;
                bottom: 90px;
                ${isLeft ? 'left' : 'right'}: 20px;
                width: 350px;
                max-width: calc(100vw - 40px);
                height: 500px;
                max-height: calc(100vh - 120px);
                background: white;
                border-radius: 12px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                z-index: 999999;
                flex-direction: column;
                overflow: hidden;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            ">
                <!-- Header -->
                <div style="
                    background: linear-gradient(135deg, ${config.branding.primaryColor}, ${config.branding.secondaryColor});
                    color: white;
                    padding: 16px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                ">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        ${config.branding.logoUrl ? `<img src="${config.branding.logoUrl}" style="height: 32px; border-radius: 4px;" />` : ''}
                        <div>
                            <div style="font-weight: 600; font-size: 16px;">${config.branding.companyName}</div>
                            <div style="font-size: 12px; opacity: 0.9;">We're here to help!</div>
                        </div>
                    </div>
                    <button id="sgsk-close-chat" style="
                        background: none;
                        border: none;
                        color: white;
                        cursor: pointer;
                        font-size: 24px;
                        padding: 4px;
                        line-height: 1;
                    ">&times;</button>
                </div>
                
                <!-- Messages Area -->
                <div id="sgsk-chat-messages" style="
                    flex: 1;
                    overflow-y: auto;
                    padding: 16px;
                    background: #f9fafb;
                ">
                    <div style="text-align: center; margin: 20px 0;">
                        <div style="
                            background: white;
                            padding: 12px 16px;
                            border-radius: 12px;
                            display: inline-block;
                            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                            color: #374151;
                        ">${config.welcomeMessage}</div>
                    </div>
                    <div id="sgsk-typing-indicator" style="display: none; padding: 8px 16px;">
                        <div style="
                            background: white;
                            padding: 8px 12px;
                            border-radius: 12px;
                            display: inline-block;
                            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                        ">
                            <span style="display: inline-block; width: 8px; height: 8px; background: #9ca3af; border-radius: 50%; margin: 0 2px; animation: typing 1.4s infinite;"></span>
                            <span style="display: inline-block; width: 8px; height: 8px; background: #9ca3af; border-radius: 50%; margin: 0 2px; animation: typing 1.4s infinite 0.2s;"></span>
                            <span style="display: inline-block; width: 8px; height: 8px; background: #9ca3af; border-radius: 50%; margin: 0 2px; animation: typing 1.4s infinite 0.4s;"></span>
                        </div>
                    </div>
                </div>
                
                <!-- Input Area -->
                <div style="padding: 16px; border-top: 1px solid #e5e7eb; background: white;">
                    <form id="sgsk-chat-form" style="display: flex; gap: 8px;">
                        <input type="text" id="sgsk-chat-input" placeholder="Type a message..." style="
                            flex: 1;
                            padding: 10px 16px;
                            border: 2px solid #e5e7eb;
                            border-radius: 24px;
                            outline: none;
                            font-size: 14px;
                            transition: border-color 0.2s;
                        " onfocus="this.style.borderColor='${config.branding.primaryColor}'" onblur="this.style.borderColor='#e5e7eb'" />
                        <button type="submit" style="
                            background: ${config.branding.primaryColor};
                            color: white;
                            border: none;
                            padding: 10px 20px;
                            border-radius: 24px;
                            cursor: pointer;
                            transition: background 0.2s;
                        " onmouseover="this.style.background='${config.branding.secondaryColor}'" onmouseout="this.style.background='${config.branding.primaryColor}'">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="22" y1="2" x2="11" y2="13"></line>
                                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                            </svg>
                        </button>
                    </form>
                    ${config.showBranding ? `<div style="text-align: center; margin-top: 8px; font-size: 10px; color: #9ca3af;">Powered by <strong>SGSK LiveChat</strong></div>` : ''}
                </div>
            </div>
            
            <style>
                @keyframes typing {
                    0%, 60%, 100% { transform: translateY(0); }
                    30% { transform: translateY(-4px); }
                }
                #sgsk-chat-messages::-webkit-scrollbar { width: 6px; }
                #sgsk-chat-messages::-webkit-scrollbar-track { background: #f1f1f1; }
                #sgsk-chat-messages::-webkit-scrollbar-thumb { background: #c7c7c7; border-radius: 3px; }
                #sgsk-chat-messages::-webkit-scrollbar-thumb:hover { background: #a8a8a8; }
            </style>
        `;
        
        document.body.appendChild(widget);
        
        // Cache DOM elements
        chatWindow = document.getElementById('sgsk-chat-window');
        chatMessages = document.getElementById('sgsk-chat-messages');
        chatInput = document.getElementById('sgsk-chat-input');
        chatForm = document.getElementById('sgsk-chat-form');
        
        // Event listeners
        document.getElementById('sgsk-chat-button').addEventListener('click', toggleChat);
        document.getElementById('sgsk-close-chat').addEventListener('click', () => {
            chatWindow.style.display = 'none';
        });
        
        chatForm.addEventListener('submit', sendMessage);
    }
    
    // Toggle chat window
    function toggleChat() {
        const isHidden = chatWindow.style.display === 'none' || chatWindow.style.display === '';
        chatWindow.style.display = isHidden ? 'flex' : 'none';
        
        if (isHidden && !isConnected) {
            initializeChat();
        }
    }
    
    // Initialize chat
    function initializeChat() {
        if (isConnected) return;
        
        // Get chat token
        fetch(`${config.apiEndpoint}/chat/initialize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                partnerId: config.partnerId,
                userMobile: userData?.mobile || '',
                userName: userData?.name || 'Website Visitor'
            })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success && data.token) {
                sessionToken = data.token;
                connectWebSocket(data);
            } else {
                console.error('Failed to initialize chat:', data);
                appendSystemMessage('Failed to connect. Please try again.');
            }
        })
        .catch(err => {
            console.error('Chat initialization error:', err);
            appendSystemMessage('Connection error. Please refresh the page.');
        });
    }
    
    // Connect to WebSocket
    function connectWebSocket(initialData) {
        if (!window.io) {
            console.error('Socket.IO not loaded');
            appendSystemMessage('Chat service unavailable. Please try again later.');
            return;
        }
        
        socket = io(initialData.websocketUrl, {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000
        });
        
        socket.on('connect', () => {
            socket.emit('authenticate', { token: sessionToken });
        });
        
        socket.on('authenticated', () => {
            isConnected = true;
            console.log('Chat connected');
            appendSystemMessage('Connected to support');
        });
        
        socket.on('new_message', (msg) => {
            appendMessage(msg.content || msg.message, 'received');
            
            // Auto-launch on operator message
            if (config.autoLaunch && chatWindow.style.display === 'none') {
                setTimeout(() => {
                    chatWindow.style.display = 'flex';
                    // Subtle animation
                    chatWindow.animate([
                        { transform: 'scale(0.95)', opacity: 0.8 },
                        { transform: 'scale(1)', opacity: 1 }
                    ], { duration: 200, easing: 'ease-out' });
                    
                    // Play notification sound (optional)
                    playNotificationSound();
                }, config.autoLaunchDelay);
            }
        });
        
        socket.on('user_typing', () => {
            // Could show typing indicator
        });
        
        socket.on('connect_error', (err) => {
            console.error('Connection error:', err);
            appendSystemMessage('Connection lost. Reconnecting...');
        });
        
        socket.on('disconnect', () => {
            isConnected = false;
            appendSystemMessage('Disconnected. Click to reconnect.');
        });
    }
    
    // Send message
    function sendMessage(e) {
        e.preventDefault();
        const message = chatInput.value.trim();
        
        if (!message || !socket) return;
        
        socket.emit('send_message', { message });
        appendMessage(message, 'sent');
        chatInput.value = '';
        
        // Track analytics
        if (config.analytics) {
            trackEvent('message_sent', { length: message.length });
        }
    }
    
    // Append message
    function appendMessage(text, type) {
        const msgDiv = document.createElement('div');
        msgDiv.style.cssText = `
            margin: 8px 0;
            text-align: ${type === 'sent' ? 'right' : 'left'};
        `;
        
        const bgColor = type === 'sent' ? config.branding.primaryColor : 'white';
        const color = type === 'sent' ? 'white' : '#1f2937';
        
        msgDiv.innerHTML = `
            <span style="
                display: inline-block;
                padding: 10px 14px;
                background: ${bgColor};
                color: ${color};
                border-radius: 16px;
                max-width: 80%;
                box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                word-wrap: break-word;
            ">${escapeHtml(text)}</span>
        `;
        
        // Insert before typing indicator
        const typingIndicator = document.getElementById('sgsk-typing-indicator');
        chatMessages.insertBefore(msgDiv, typingIndicator);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    
    // Append system message
    function appendSystemMessage(text) {
        const msgDiv = document.createElement('div');
        msgDiv.style.cssText = `
            text-align: center;
            margin: 12px 0;
            font-size: 12px;
            color: #6b7280;
        `;
        msgDiv.textContent = text;
        chatMessages.appendChild(msgDiv);
    }
    
    // Escape HTML
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Play notification sound
    function playNotificationSound() {
        // Simple beep using Web Audio API (no external file needed)
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            oscillator.frequency.value = 800;
            oscillator.type = 'sine';
            gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);
            
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.15);
        } catch (e) {
            // Audio not supported or blocked
        }
    }
    
    // Track analytics event
    function trackEvent(eventType, data) {
        if (!config.analytics) return;
        
        navigator.sendBeacon(
            `${config.apiEndpoint}/analytics/track`,
            JSON.stringify({
                partnerId: config.partnerId,
                eventType: eventType,
                eventData: data,
                timestamp: new Date().toISOString()
            })
        );
    }
    
    // Load Socket.IO
    function loadSocketIO(callback) {
        if (window.io) {
            callback();
            return;
        }
        
        const script = document.createElement('script');
        script.src = 'https://cdn.socket.io/4.6.1/socket.io.min.js';
        script.onload = callback;
        document.head.appendChild(script);
    }
    
    // Initialize
    function init() {
        config = getConfig();
        
        if (!config.partnerId) {
            console.warn('SGSK Chat: partnerId not configured');
            return;
        }
        
        createWidget(config);
        loadSocketIO(() => {
            console.log('SGSK Chat initialized');
        });
    }
    
    // Start when DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    // Expose API for external control
    window.SGSKChat = {
        open: toggleChat,
        close: () => { if (chatWindow) chatWindow.style.display = 'none'; },
        sendMessage: (message) => {
            if (socket && isConnected) {
                socket.emit('send_message', { message });
            }
        },
        setUserData: (data) => { userData = data; },
        trackEvent: trackEvent
    };
    
})();
