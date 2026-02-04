import { MessageListRenderer } from './MessageListRenderer.js';
import { MessageContentRenderer } from './MessageContentRenderer.js';
import { AttachmentModalManager } from './AttachmentModalManager.js';
import { ToastManager } from './ToastManager.js';
import { SearchManager } from '../SearchManager.js';
import { isTauri, saveFileWithDialog } from '../tauri-bridge.js';
import { buildEmlDownload } from '../emlExport.js';

// Debounce time for attachment clicks (Windows double-click interval)
const ATTACHMENT_CLICK_DEBOUNCE_MS = 500;

/**
 * Manages the user interface for the email reader application
 * Delegates to specialized sub-managers
 */
class UIManager {
    constructor(messageHandler) {
        this.messageHandler = messageHandler;
        this.lastAttachmentClickTime = 0;

        // Screen elements
        this.welcomeScreen = document.getElementById('welcomeScreen');
        this.appContainer = document.getElementById('appContainer');
        this.dropOverlay = document.querySelector('.drop-overlay');

        // Initialize sub-managers
        this.toasts = new ToastManager();
        this.modal = new AttachmentModalManager((msg, type) => this.showToast(msg, type));
        this.searchManager = new SearchManager(messageHandler);
        this.messageList = new MessageListRenderer(
            document.getElementById('messageItems'),
            messageHandler
        );
        this.messageContent = new MessageContentRenderer(
            document.getElementById('messageViewer'),
            messageHandler,
            this.modal
        );

        // Search elements
        this.searchInput = document.getElementById('search-input');
        this.searchClearBtn = document.getElementById('search-clear');
        this.searchResultsCount = document.getElementById('search-results-count');
        this.srAnnouncements = document.getElementById('srAnnouncements');
        this.bulkActions = document.getElementById('bulkActions');
        this.bulkSelectToggle = this.bulkActions?.querySelector('[data-action="bulk-select-toggle"]') || null;
        this.bulkActionsMeta = document.getElementById('bulkActionsMeta');
        this.bulkDownloadBtn = this.bulkActions?.querySelector('[data-action="bulk-download"]') || null;
        this.bulkPinBtn = this.bulkActions?.querySelector('[data-action="bulk-pin"]') || null;
        this.bulkDeleteBtn = this.bulkActions?.querySelector('[data-action="bulk-delete"]') || null;

        this.keyboardManager = null;
        this.devPanel = null;
        this.initEventDelegation();
        this.initSearchListeners();
        this.initBulkActions();
    }

    setKeyboardManager(keyboardManager) {
        this.keyboardManager = keyboardManager;
        this.modal.setKeyboardManager(keyboardManager);
    }

    /**
     * Set the dev panel reference
     * @param {DevPanel} devPanel - DevPanel instance
     */
    setDevPanel(devPanel) {
        this.devPanel = devPanel;
    }

    initEventDelegation() {
        // Message item clicks
        document.getElementById('messageItems')?.addEventListener('click', (e) => {
            if (e.target.closest('[data-action="select-message"]')) {
                return;
            }
            const item = e.target.closest('[data-message-index]');
            if (item && window.app) {
                window.app.showMessage(parseInt(item.dataset.messageIndex, 10));
            }
        });

        // Message selection checkboxes
        document.getElementById('messageItems')?.addEventListener('change', (e) => {
            const checkbox = e.target.closest('[data-action="select-message"]');
            if (!checkbox) return;

            const index = parseInt(checkbox.dataset.messageIndex, 10);
            const message = this.messageHandler.getMessages()[index];
            if (!message) return;

            this.messageHandler.setSelected(message, checkbox.checked);
            const item = checkbox.closest('.message-item');
            if (item) {
                item.classList.toggle('selected', checkbox.checked);
                item.setAttribute('aria-selected', checkbox.checked ? 'true' : 'false');
            }

            this.updateBulkActions();
        });

        // Message viewer actions
        document.getElementById('messageViewer')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn || !window.app) return;

            const action = btn.dataset.action;
            const index = parseInt(btn.dataset.index, 10);

            if (action === 'pin') window.app.togglePin(index);
            else if (action === 'delete') window.app.deleteMessage(index);
            else if (action === 'download-eml') {
                if (Number.isNaN(index)) return;
                const message = this.messageHandler.getMessages()[index];
                if (message) {
                    this.downloadMessageAsEml(message);
                }
            }
            else if (action === 'preview' || action === 'download') {
                // Debounce attachment clicks to prevent double-open from Outlook habits
                const now = Date.now();
                if (now - this.lastAttachmentClickTime < ATTACHMENT_CLICK_DEBOUNCE_MS) {
                    return;
                }
                this.lastAttachmentClickTime = now;

                const attIdx = parseInt(btn.dataset.attachmentIndex, 10);
                const attachments = this.modal.getAttachments();
                if (!attachments?.[attIdx]) return;

                if (action === 'preview') {
                    this.modal.open(attachments[attIdx]);
                } else {
                    e.stopPropagation();
                    this.downloadAttachment(attachments[attIdx]);
                }
            }
        });
    }

    /**
     * Initialize search input event listeners
     */
    initSearchListeners() {
        if (!this.searchInput) return;

        // Search input handler with debounce
        this.searchInput.addEventListener('input', (e) => {
            const query = e.target.value;
            this.updateSearchUI(query);

            this.searchManager.searchDebounced(query, (results) => {
                this.messageList.renderFiltered(results);
                this.updateSearchResultsCount(results.length, query);
                this.updateBulkActions();
            });
        });

        // Keyboard navigation from search
        this.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.clearSearch();
                this.searchInput.blur();
            } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
                // Jump to first result
                const filteredMessages = this.messageList.getFilteredMessages();
                if (filteredMessages.length > 0 && window.app) {
                    e.preventDefault();
                    const allMessages = this.messageHandler.getMessages();
                    const firstResultIndex = allMessages.indexOf(filteredMessages[0]);
                    window.app.showMessage(firstResultIndex);
                    this.searchInput.blur();
                    document.getElementById('messageItems')?.focus();
                }
            }
        });

        // Clear button handler
        this.searchClearBtn?.addEventListener('click', () => {
            this.clearSearch();
            this.searchInput.focus();
        });
    }

    /**
     * Update search UI elements (clear button visibility)
     * @param {string} query - Current search query
     */
    updateSearchUI(query) {
        if (this.searchClearBtn) {
            if (query.length > 0) {
                this.searchClearBtn.classList.remove('hidden');
            } else {
                this.searchClearBtn.classList.add('hidden');
            }
        }
    }

    /**
     * Update search results count display
     * @param {number} count - Number of results
     * @param {string} query - Search query
     */
    updateSearchResultsCount(count, query) {
        if (!this.searchResultsCount) return;

        // Hide count if no query or no results (empty state handles "no results" display)
        if (!query || query.trim().length === 0 || count === 0) {
            this.searchResultsCount.classList.add('hidden');
            this.searchResultsCount.classList.remove('no-results');
        } else {
            this.searchResultsCount.classList.remove('hidden');
            this.searchResultsCount.classList.remove('no-results');
            this.searchResultsCount.textContent = `${count} ${count === 1 ? 'result' : 'results'} found`;
        }

        // Announce for screen readers
        this.announceSearchResults(count);
    }

    /**
     * Announce search results for screen readers
     * @param {number} count - Number of results
     */
    announceSearchResults(count) {
        if (!this.srAnnouncements) return;

        const message = count === 0
            ? 'No results found'
            : `${count} ${count === 1 ? 'result' : 'results'} found`;

        this.srAnnouncements.textContent = message;
        setTimeout(() => {
            this.srAnnouncements.textContent = '';
        }, 1000);
    }

    /**
     * Clear search and restore full message list
     */
    clearSearch() {
        if (this.searchInput) {
            this.searchInput.value = '';
        }
        this.updateSearchUI('');
        const allMessages = this.searchManager.clearSearch();
        this.messageList.renderFiltered(allMessages);
        this.updateSearchResultsCount(0, '');
        this.updateBulkActions();
    }

    /**
     * Focus the search input
     */
    focusSearch() {
        this.searchInput?.focus();
    }

    /**
     * Check if search input is focused
     * @returns {boolean}
     */
    isSearchFocused() {
        return document.activeElement === this.searchInput;
    }

    // Screen management
    showWelcomeScreen() {
        this.welcomeScreen.style.display = 'flex';
        this.appContainer.style.display = 'none';
    }

    showAppContainer() {
        this.welcomeScreen.style.display = 'none';
        this.appContainer.style.display = 'flex';
    }

    // Message rendering - delegated
    updateMessageList() {
        // If search is active, render filtered results, otherwise render all
        if (this.searchManager.isSearchActive()) {
            const results = this.searchManager.search(this.searchManager.getQuery());
            this.messageList.renderFiltered(results);
        } else {
            this.messageList.render();
        }
        this.updateBulkActions();
    }

    showMessage(msgInfo) {
        this.messageContent.render(msgInfo);
        this.updateMessageList();

        // Update dev panel with debug data if available or panel is visible
        if (this.devPanel && this.devPanel.isVisible) {
            if (msgInfo._debugData) {
                this.devPanel.setDebugData(msgInfo._debugData);
            } else if (msgInfo._rawBuffer && window.app?.reloadDebugData) {
                // Reload debug data on demand
                window.app.reloadDebugData(msgInfo);
            }
        }
    }

    // Drop overlay
    showDropOverlay() {
        this.dropOverlay?.classList.add('active');
    }

    hideDropOverlay() {
        this.dropOverlay?.classList.remove('active');
    }

    // Toast notifications - delegated
    showToast(message, type = 'info', duration) {
        this.toasts.show(message, type, duration);
    }

    showError(message, duration = 5000) {
        this.toasts.error(message, duration);
    }

    showWarning(message, duration = 4000) {
        this.toasts.warning(message, duration);
    }

    showInfo(message, duration = 3000) {
        this.toasts.info(message, duration);
    }

    /**
     * Download an attachment using save dialog in Tauri or browser fallback
     * @param {Object} attachment - Attachment object with contentBase64 and fileName
     */
    async downloadAttachment(attachment) {
        if (isTauri()) {
            try {
                const saved = await saveFileWithDialog(
                    attachment.contentBase64,
                    attachment.fileName
                );
                if (saved) {
                    this.showInfo('File saved successfully');
                }
            } catch (error) {
                console.error('Failed to save file:', error);
                this.showError('Failed to save file');
            }
        } else {
            // Browser fallback: use traditional download
            const link = document.createElement('a');
            link.href = attachment.contentBase64;
            link.download = attachment.fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    }

    /**
     * Initialize bulk actions toolbar
     */
    initBulkActions() {
        if (!this.bulkActions) return;

        this.bulkActions.addEventListener('click', (e) => {
            const button = e.target.closest('[data-action^="bulk-"]');
            if (!button) return;

            const action = button.dataset.action;
            if (action === 'bulk-select-toggle') {
                this.toggleSelectAll();
            } else if (action === 'bulk-download') {
                this.handleBulkDownload();
            } else if (action === 'bulk-delete') {
                this.handleBulkDelete();
            } else if (action === 'bulk-pin') {
                this.handleBulkPin();
            }
        });

        this.updateBulkActions();
    }

    /**
     * Gets the current bulk scope messages (filtered if search active, otherwise all)
     * @returns {Array}
     */
    getBulkScopeMessages() {
        if (this.searchManager?.isSearchActive()) {
            return this.messageList.getFilteredMessages();
        }
        return this.messageHandler.getMessages();
    }

    /**
     * Gets bulk target messages based on selection or scope
     * @returns {{messages: Array, scope: string}}
     */
    getBulkTargetMessages() {
        const selectedMessages = this.messageHandler.getSelectedMessages
            ? this.messageHandler.getSelectedMessages()
            : [];

        if (selectedMessages.length > 0) {
            return { messages: selectedMessages, scope: 'selected' };
        }

        const scopeMessages = this.getBulkScopeMessages();
        const scope = this.searchManager?.isSearchActive() ? 'filtered' : 'all';
        return { messages: scopeMessages, scope };
    }

    /**
     * Updates bulk actions toolbar state
     */
    updateBulkActions() {
        if (!this.bulkActions) return;

        const scopeMessages = this.getBulkScopeMessages();
        const selectedMessages = this.messageHandler.getSelectedMessages
            ? this.messageHandler.getSelectedMessages()
            : [];
        const selectedCount = selectedMessages.length;

        const { messages: targetMessages, scope } = this.getBulkTargetMessages();
        const targetCount = targetMessages.length;

        if (this.bulkActionsMeta) {
            if (selectedCount > 0) {
                this.bulkActionsMeta.textContent = `${selectedCount} selected`;
            } else if (scopeMessages.length === 0) {
                this.bulkActionsMeta.textContent = 'No messages';
            } else {
                const label = scope === 'filtered' ? 'filtered' : 'total';
                this.bulkActionsMeta.textContent = `${scopeMessages.length} ${label}`;
            }
        }

        const allScopeSelected = scopeMessages.length > 0 &&
            scopeMessages.every(msg => this.messageHandler.isSelected?.(msg));
        const anyScopeSelected = scopeMessages.some(msg => this.messageHandler.isSelected?.(msg));

        if (this.bulkSelectToggle) {
            const selectLabel = this.bulkSelectToggle.querySelector('span');
            const shouldSelectAll = !allScopeSelected;
            const label = scope === 'filtered' ? 'Select filtered' : 'Select all';
            if (selectLabel) {
                selectLabel.textContent = shouldSelectAll ? label : 'Clear selection';
            }
            this.bulkSelectToggle.classList.toggle('active', allScopeSelected);
            this.bulkSelectToggle.classList.toggle('partial', !allScopeSelected && anyScopeSelected);
            this.bulkSelectToggle.disabled = scopeMessages.length === 0;
            this.bulkSelectToggle.setAttribute('aria-pressed', (allScopeSelected || anyScopeSelected) ? 'true' : 'false');
            this.bulkSelectToggle.title = shouldSelectAll ? label : 'Clear selection';
        }

        const disableActions = targetCount === 0;
        if (this.bulkDownloadBtn) this.bulkDownloadBtn.disabled = disableActions;
        if (this.bulkDeleteBtn) this.bulkDeleteBtn.disabled = disableActions;
        if (this.bulkPinBtn) {
            this.bulkPinBtn.disabled = disableActions;
            const allPinned = targetMessages.length > 0 &&
                targetMessages.every(msg => this.messageHandler.isPinned?.(msg));
            const label = this.bulkPinBtn.querySelector('span');
            if (label) {
                label.textContent = allPinned ? 'Unpin' : 'Pin';
            }
            this.bulkPinBtn.title = allPinned ? 'Remove bookmark' : 'Bookmark selected';
        }
    }

    /**
     * Selects or deselects all messages in the current scope
     * @param {boolean} selected
     */
    toggleSelectAll() {
        const scopeMessages = this.getBulkScopeMessages();
        const allScopeSelected = scopeMessages.length > 0 &&
            scopeMessages.every(msg => this.messageHandler.isSelected?.(msg));
        this.messageHandler.setSelectionForMessages(scopeMessages, !allScopeSelected);
        this.updateMessageList();
    }

    /**
     * Handle bulk download action
     */
    async handleBulkDownload() {
        const { messages } = this.getBulkTargetMessages();
        if (!messages.length) return;

        for (const message of messages) {
            await this.downloadMessageAsEml(message);
        }
    }

    /**
     * Handle bulk delete action
     */
    handleBulkDelete() {
        const { messages } = this.getBulkTargetMessages();
        if (!messages.length || !window.app?.bulkDeleteMessages) return;

        window.app.bulkDeleteMessages(messages);
        this.updateBulkActions();
    }

    /**
     * Handle bulk pin/unpin action
     */
    handleBulkPin() {
        const { messages } = this.getBulkTargetMessages();
        if (!messages.length || !window.app?.bulkSetPinned) return;

        const allPinned = messages.every(msg => this.messageHandler.isPinned?.(msg));
        window.app.bulkSetPinned(messages, !allPinned);
        this.updateBulkActions();
    }

    /**
     * Download the current message as an EML file
     * @param {Object} message - Message object to export
     */
    async downloadMessageAsEml(message) {
        try {
            const download = buildEmlDownload(message);
            if (!download) return;

            if (isTauri()) {
                const saved = await saveFileWithDialog(download.dataUrl, download.fileName);
                if (saved) {
                    this.showInfo('Email saved successfully');
                }
            } else {
                const link = document.createElement('a');
                link.href = download.dataUrl;
                link.download = download.fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }
        } catch (error) {
            console.error('Failed to export email:', error);
            this.showError('Failed to export email');
        }
    }

    // Attachment modal - delegated
    openAttachmentModal(attachment) {
        this.modal.open(attachment);
    }

    closeAttachmentModal() {
        this.modal.close();
    }

    showPrevAttachment() {
        this.modal.showPrevAttachment();
    }

    showNextAttachment() {
        this.modal.showNextAttachment();
    }
}

export default UIManager;
