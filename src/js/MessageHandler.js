import { storage } from './storage.js';
import md5 from 'md5';

/**
 * Manages email messages and their state
 * Handles message storage, pinning, sorting, and current selection
 */
class MessageHandler {
    /**
     * Creates a new MessageHandler instance
     * @param {Storage} [storageInstance] - Optional storage instance for dependency injection
     */
    constructor(storageInstance = null) {
        this.storage = storageInstance || storage;
        this.messages = [];
        this.currentMessage = null;
        this.pinnedMessages = new Set(this.storage.get('pinnedMessages', []));
        this.selectedMessages = new Set();
    }

    /**
     * Adds a new message to the handler
     * @param {Object} msgInfo - Parsed message data
     * @param {string} fileName - Original filename of the email file
     * @returns {Object} The added message with hash and timestamp
     */
    addMessage(msgInfo, fileName) {
        // Generate hash from message properties
        const hashInput = `${msgInfo.senderEmail}-${msgInfo.messageDeliveryTime}-${msgInfo.subject}-${fileName}`;
        const hash = md5(hashInput);

        // Robust date parsing: try multiple fields
        const dateFields = [
            msgInfo.messageDeliveryTime,
            msgInfo.clientSubmitTime,
            msgInfo.creationTime,
            msgInfo.lastModificationTime
        ];
        let parsedDate = null;
        for (const val of dateFields) {
            if (val) {
                const d = new Date(val);
                if (!isNaN(d.getTime())) {
                    parsedDate = d;
                    break;
                }
            }
        }

        // Add message to list
        const message = {
            ...msgInfo,
            fileName,
            messageHash: hash,
            timestamp: parsedDate
        };

        this.messages.unshift(message);
        this.sortMessages();
        return message;
    }

    /**
     * Sorts messages by timestamp in descending order (newest first)
     */
    sortMessages() {
        this.messages.sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Deletes a message at the specified index
     * @param {number} index - Index of the message to delete
     * @returns {Object|null} The next message (or previous if last), or null if no messages remain
     */
    deleteMessage(index) {
        const msgInfo = this.messages[index];
        this.messages.splice(index, 1);
        this.pinnedMessages.delete(msgInfo.messageHash);
        this.selectedMessages.delete(msgInfo.messageHash);
        this.savePinnedMessages();

        if (this.messages.length === 0) {
            return null;
        }

        // Return the message at the same index (next message moves up)
        // or the last message if we deleted the last one
        const nextIndex = Math.min(index, this.messages.length - 1);
        return this.messages[nextIndex];
    }

    /**
     * Deletes multiple messages by hash
     * @param {Iterable<string>} hashes - Message hashes to delete
     * @returns {number} Number of deleted messages
     */
    deleteMessagesByHash(hashes) {
        const hashSet = new Set(hashes);
        if (hashSet.size === 0) return 0;

        const beforeCount = this.messages.length;
        this.messages = this.messages.filter(msg => !hashSet.has(msg.messageHash));

        hashSet.forEach(hash => {
            this.pinnedMessages.delete(hash);
            this.selectedMessages.delete(hash);
        });

        this.savePinnedMessages();
        return beforeCount - this.messages.length;
    }

    /**
     * Toggles the pinned state of a message
     * @param {number} index - Index of the message to toggle
     * @returns {Object} The toggled message
     */
    togglePin(index) {
        const msgInfo = this.messages[index];
        if (this.isPinned(msgInfo)) {
            this.pinnedMessages.delete(msgInfo.messageHash);
        } else {
            this.pinnedMessages.add(msgInfo.messageHash);
        }
        this.savePinnedMessages();
        return msgInfo;
    }

    /**
     * Sets pinned state for a set of messages by hash
     * @param {Iterable<string>} hashes - Message hashes to update
     * @param {boolean} pinned - Whether messages should be pinned
     */
    setPinnedByHash(hashes, pinned) {
        const hashSet = new Set(hashes);
        hashSet.forEach(hash => {
            if (pinned) {
                this.pinnedMessages.add(hash);
            } else {
                this.pinnedMessages.delete(hash);
            }
        });
        this.savePinnedMessages();
    }

    /**
     * Checks if a message is pinned
     * @param {Object} msgInfo - Message object to check
     * @returns {boolean} True if the message is pinned
     */
    isPinned(msgInfo) {
        return this.pinnedMessages.has(msgInfo.messageHash);
    }

    /**
     * Checks if a message is selected
     * @param {Object} msgInfo - Message object to check
     * @returns {boolean} True if the message is selected
     */
    isSelected(msgInfo) {
        return this.selectedMessages.has(msgInfo.messageHash);
    }

    /**
     * Sets selection state for a message
     * @param {Object} msgInfo - Message object to update
     * @param {boolean} selected - Whether the message should be selected
     */
    setSelected(msgInfo, selected) {
        if (!msgInfo?.messageHash) return;
        if (selected) {
            this.selectedMessages.add(msgInfo.messageHash);
        } else {
            this.selectedMessages.delete(msgInfo.messageHash);
        }
    }

    /**
     * Clears all selected messages
     */
    clearSelection() {
        this.selectedMessages.clear();
    }

    /**
     * Selects or deselects a list of messages
     * @param {Array} messages - Messages to update
     * @param {boolean} selected - Whether to select or deselect
     */
    setSelectionForMessages(messages, selected) {
        if (!Array.isArray(messages)) return;
        messages.forEach(msg => this.setSelected(msg, selected));
    }

    /**
     * Gets all selected messages
     * @returns {Array} Selected messages array
     */
    getSelectedMessages() {
        return this.messages.filter(msg => this.selectedMessages.has(msg.messageHash));
    }

    /**
     * Persists the pinned messages set to storage
     */
    savePinnedMessages() {
        this.storage.set('pinnedMessages', [...this.pinnedMessages]);
    }

    /**
     * Sets the currently displayed message
     * @param {Object} message - Message to set as current
     */
    setCurrentMessage(message) {
        this.currentMessage = message;
    }

    /**
     * Gets the currently displayed message
     * @returns {Object|null} The current message or null
     */
    getCurrentMessage() {
        return this.currentMessage;
    }

    /**
     * Gets all loaded messages
     * @returns {Array} Array of message objects
     */
    getMessages() {
        return this.messages;
    }
}

export default MessageHandler;
