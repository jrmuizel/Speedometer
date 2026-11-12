// A small browser shim for running the SocialFeed-React workload in a
// JavaScript shell. It implements the parts of the DOM the workload touches:
// a tree with attributes and selectors, events, timers, observers, history,
// and enough of fetch/URL to read the workload's prepared responses from disk.
//
// This is deliberately not a browser. Layout is a deterministic
// approximation (feed units are 450px tall), which is enough for the feed's
// virtualization and pagination to make the same decisions as in a browser.

(function () {
    if ("window" in globalThis)
        return;

    const g = globalThis;
    g.window = g;
    g.self = g;
    g.top = {}; // Make SiteConfig.benchmarkMode true.

    if (!g.console)
        g.console = {};
    if (!g.console.log)
        g.console.log = (...args) => print(args.map(String).join(" "));
    if (!g.console.error) {
        g.console.error = (...args) => {
            for (const arg of args) {
                if (arg && typeof arg.stack === "string")
                    print(arg.stack);
                else
                    g.console.log(...args);
            }
        };
    }
    if (!g.console.warn)
        g.console.warn = g.console.log;
    if (!g.console.assert) {
        g.console.assert = function (value, ...args) {
            if (!value)
                throw new Error("Assertion failed" + (args.length ? ": " + args.join(" ") : ""));
        };
    }
    if (!g.performance)
        g.performance = { now: () => preciseTime() * 1000 };

    if (!g.queueMicrotask) {
        g.queueMicrotask = (callback) => Promise.resolve().then(callback);
    }

    // The shell already has a working setTimeout event loop. Keep it.
    const nativeSetTimeout = g.setTimeout ? g.setTimeout.bind(g) : null;
    const nativeClearTimeout = g.clearTimeout ? g.clearTimeout.bind(g) : null;
    if (!nativeSetTimeout) {
        const timers = new Map();
        let nextTimer = 1;
        g.setTimeout = (callback, delay = 0, ...args) => {
            const id = nextTimer++;
            timers.set(id, { callback, args });
            return id;
        };
        g.clearTimeout = (id) => timers.delete(id);
        g.__runTimers = () => {
            while (timers.size) {
                const [id, timer] = timers.entries().next().value;
                timers.delete(id);
                timer.callback(...timer.args);
            }
        };
    } else if (!nativeClearTimeout) {
        g.clearTimeout = () => {};
    }

    // MessageChannel is used by both Workload.afterTask() and React's
    // scheduler. Deliver each message in its own task.
    g.MessageChannel = class MessageChannel {
        constructor() {
            this.port1 = { onmessage: null };
            this.port2 = {
                postMessage: (data) => {
                    g.setTimeout(() => {
                        if (this.port1.onmessage)
                            this.port1.onmessage({ data });
                    }, 0);
                },
            };
        }
    };

    g.requestAnimationFrame = (callback) => g.setTimeout(() => callback(g.performance.now()), 0);
    g.cancelAnimationFrame = (id) => g.clearTimeout(id);
    g.requestIdleCallback = (callback) => g.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0);
    g.cancelIdleCallback = (id) => g.clearTimeout(id);

    let scriptDir = g.__speedometerScriptBase || "";
    if (typeof scriptPath === "string") {
        const normalized = scriptPath.replace(/\\/g, "/");
        scriptDir = normalized.slice(0, normalized.lastIndexOf("/") + 1);
    }

    function readFile(path) {
        path = String(path).replace(/^\.?\//, "");
        if (typeof os !== "undefined" && os.file && os.file.readRelativeToScript)
            return os.file.readRelativeToScript(path);
        if (typeof readRelativeToScript === "function")
            return readRelativeToScript(path);
        if (typeof read === "function")
            return read(scriptDir + path);
        throw new Error("No file reader for " + path);
    }

    function loadFile(path) {
        if (typeof loadRelativeToScript === "function")
            return loadRelativeToScript(path);
        if (typeof load === "function")
            return load(scriptDir + path);
        throw new Error("No file loader for " + path);
    }
    g.__loadWorkloadFile = loadFile;

    function writeFile(path, contents) {
        if (typeof os !== "undefined" && os.file && os.file.writeTypedArrayToFile) {
            os.file.writeTypedArrayToFile(path, new TextEncoder().encode(contents));
            return;
        }
        throw new Error("No file writer for " + path);
    }

    g.__readWorkloadFile = readFile;
    g.__scriptDir = scriptDir;

    // ------------------------------------------------------------------
    // Selectors

    function splitTopLevel(text, separator) {
        const result = [];
        let start = 0;
        let bracket = 0;
        let paren = 0;
        let quote = null;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (quote) {
                if (ch === quote && text[i - 1] !== "\\")
                    quote = null;
            } else if (ch === '"' || ch === "'") {
                quote = ch;
            } else if (ch === "[") {
                bracket++;
            } else if (ch === "]") {
                bracket--;
            } else if (ch === "(") {
                paren++;
            } else if (ch === ")") {
                paren--;
            } else if (ch === separator && bracket === 0 && paren === 0) {
                result.push(text.slice(start, i));
                start = i + 1;
            }
        }
        result.push(text.slice(start));
        return result;
    }

    function splitSelector(selector) {
        const parts = [];
        let token = "";
        let bracket = 0;
        let paren = 0;
        let quote = null;
        let combinator = null;
        const flush = () => {
            if (token.trim()) {
                parts.push({ combinator, compound: token.trim() });
                token = "";
                combinator = null;
            }
        };
        for (let i = 0; i < selector.length; i++) {
            const ch = selector[i];
            if (quote) {
                token += ch;
                if (ch === quote && selector[i - 1] !== "\\")
                    quote = null;
            } else if (ch === '"' || ch === "'") {
                quote = ch;
                token += ch;
            } else if (ch === "[") {
                bracket++;
                token += ch;
            } else if (ch === "]") {
                bracket--;
                token += ch;
            } else if (ch === "(") {
                paren++;
                token += ch;
            } else if (ch === ")") {
                paren--;
                token += ch;
            } else if (bracket === 0 && paren === 0 && (ch === ">" || ch === "+" || ch === "~")) {
                flush();
                combinator = ch;
            } else if (bracket === 0 && paren === 0 && /\s/.test(ch)) {
                if (token.trim() && combinator === null)
                    combinator = " ";
                flush();
            } else {
                token += ch;
            }
        }
        flush();
        return parts;
    }

    function parseCompound(text) {
        const compound = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
        let i = 0;
        const tagMatch = text.slice(i).match(/^(\*|[A-Za-z][\w:-]*)/);
        if (tagMatch) {
            compound.tag = tagMatch[1] === "*" ? null : tagMatch[1].toLowerCase();
            i += tagMatch[0].length;
        }
        while (i < text.length) {
            const ch = text[i];
            if (ch === "#") {
                i++;
                let name = "";
                while (i < text.length && /[\w-]/.test(text[i]))
                    name += text[i++];
                compound.id = name;
            } else if (ch === ".") {
                i++;
                let name = "";
                while (i < text.length && /[\w-]/.test(text[i]))
                    name += text[i++];
                compound.classes.push(name);
            } else if (ch === "[") {
                const end = findClosing(text, i, "[", "]");
                const body = text.slice(i + 1, end).trim();
                i = end + 1;
                const match = body.match(/^([^\s~|^$*!=]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?$/);
                if (match) {
                    compound.attrs.push({
                        name: match[1],
                        operator: match[2] || null,
                        value: match[3] ?? match[4] ?? match[5] ?? "",
                    });
                }
            } else if (ch === ":") {
                i++;
                let name = "";
                while (i < text.length && /[\w-]/.test(text[i]))
                    name += text[i++];
                let argument = null;
                if (text[i] === "(") {
                    const end = findClosing(text, i, "(", ")");
                    argument = text.slice(i + 1, end);
                    i = end + 1;
                }
                compound.pseudos.push({ name: name.toLowerCase(), argument });
            } else {
                i++;
            }
        }
        return compound;
    }

    function findClosing(text, start, open, close) {
        let depth = 0;
        let quote = null;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (quote) {
                if (ch === quote && text[i - 1] !== "\\")
                    quote = null;
            } else if (ch === '"' || ch === "'") {
                quote = ch;
            } else if (ch === open) {
                depth++;
            } else if (ch === close) {
                depth--;
                if (depth === 0)
                    return i;
            }
        }
        return text.length - 1;
    }

    function getClasses(element) {
        return (element.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    }

    function matchAttribute(element, test) {
        const value = element.getAttribute(test.name);
        if (value === null)
            return false;
        if (!test.operator)
            return true;
        switch (test.operator) {
            case "=":
                return value === test.value;
            case "~=":
                return value.split(/\s+/).includes(test.value);
            case "|=":
                return value === test.value || value.startsWith(test.value + "-");
            case "^=":
                return value.startsWith(test.value);
            case "$=":
                return value.endsWith(test.value);
            case "*=":
                return value.includes(test.value);
            default:
                return false;
        }
    }

    function siblingIndex(element) {
        const parent = element.parentNode;
        if (!parent)
            return 1;
        return parent.childNodes.filter((node) => node.nodeType === 1).indexOf(element) + 1;
    }

    function matchCompound(element, compound) {
        if (!element || element.nodeType !== 1)
            return false;
        if (compound.tag && element.tagName.toLowerCase() !== compound.tag)
            return false;
        if (compound.id && element.getAttribute("id") !== compound.id)
            return false;
        if (compound.classes.length) {
            const classes = getClasses(element);
            if (!compound.classes.every((name) => classes.includes(name)))
                return false;
        }
        for (const attr of compound.attrs) {
            if (!matchAttribute(element, attr))
                return false;
        }
        for (const pseudo of compound.pseudos) {
            switch (pseudo.name) {
                case "not":
                    if (matchSelector(element, pseudo.argument))
                        return false;
                    break;
                case "first-child":
                    if (siblingIndex(element) !== 1)
                        return false;
                    break;
                case "last-child": {
                    const siblings = element.parentNode ? element.parentNode.childNodes.filter((node) => node.nodeType === 1) : [element];
                    if (siblings[siblings.length - 1] !== element)
                        return false;
                    break;
                }
                case "nth-child": {
                    const index = siblingIndex(element);
                    const arg = (pseudo.argument || "").trim().toLowerCase();
                    if (arg === "odd" && index % 2 !== 1)
                        return false;
                    if (arg === "even" && index % 2 !== 0)
                        return false;
                    if (/^\d+$/.test(arg) && Number(arg) !== index)
                        return false;
                    break;
                }
                case "scope":
                    if (element !== currentScope)
                        return false;
                    break;
                default:
                    // Unknown pseudo-class: ignore it rather than rejecting
                    // every element (CSS in this workload only uses :focus-visible
                    // in stylesheet text, not in DOM queries).
                    break;
            }
        }
        return true;
    }

    function matchSelector(element, selector) {
        for (const alternative of splitTopLevel(selector, ",")) {
            const parts = splitSelector(alternative.trim());
            if (matchSelectorParts(element, parts, parts.length - 1))
                return true;
        }
        return false;
    }

    function matchSelectorParts(element, parts, index) {
        if (index < 0)
            return true;
        const part = parts[index];
        if (!matchCompound(element, parseCompound(part.compound)))
            return false;
        if (index === 0)
            return true;
        const combinator = part.combinator || " ";
        if (combinator === ">") {
            const parent = element.parentElement;
            return !!parent && matchSelectorParts(parent, parts, index - 1);
        }
        if (combinator === "+") {
            const sibling = element.previousElementSibling;
            return !!sibling && matchSelectorParts(sibling, parts, index - 1);
        }
        if (combinator === "~") {
            let sibling = element.previousElementSibling;
            while (sibling) {
                if (matchSelectorParts(sibling, parts, index - 1))
                    return true;
                sibling = sibling.previousElementSibling;
            }
            return false;
        }
        let parent = element.parentElement;
        while (parent) {
            if (matchSelectorParts(parent, parts, index - 1))
                return true;
            parent = parent.parentElement;
        }
        return false;
    }

    let currentScope = null;
    const parsedSelectorCache = new Map();
    function parseSelector(selector) {
        let cached = selectorCache.get(selector);
        if (!cached) {
            cached = splitTopLevel(selector, ",").map((alternative) => splitSelector(alternative.trim()));
            selectorCache.set(selector, cached);
        }
        return cached;
    }
    const selectorCache = new Map();

    // ------------------------------------------------------------------
    // DOM tree

    let mutationObservers = [];
    let intersectionObservers = new Set();
    let resizeObservers = new Set();
    let nextUuid = 0;

    function uuid() {
        const hex = (n) => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
        return `${hex()}-${hex().slice(0, 4)}-${hex().slice(4, 8)}-${hex().slice(0, 4)}-${hex()}`;
    }

    function notifyMutation(target, type, addedNodes = [], removedNodes = [], attributeName = null) {
        if (!mutationObservers.length)
            return;
        const record = { target, type, addedNodes, removedNodes, attributeName, oldValue: null };
        for (const observer of mutationObservers)
            observer._enqueue(record);
    }

    function EventTarget() {
        this.event_listeners = Object.create(null);
        this._react_callback = null;
    }
    EventTarget.prototype.addEventListener = function (type, listener, options = {}) {
        if (!listener)
            return;
        if (type === "react-invokeguardedcallback") {
            if (!this._react_callback)
                this._react_callback = [];
            this._react_callback.push(listener);
            return;
        }
        const listeners = this.event_listeners[type] || (this.event_listeners[type] = []);
        listeners.push({ listener, once: !!options.once });
    };
    EventTarget.prototype.removeEventListener = function (type, listener) {
        if (type === "react-invokeguardedcallback") {
            if (this._react_callback)
                this._react_callback = this._react_callback.filter((cb) => cb !== listener);
            return;
        }
        const listeners = this.event_listeners[type];
        if (!listeners)
            return;
        const index = listeners.findIndex((entry) => entry.listener === listener);
        if (index !== -1)
            listeners.splice(index, 1);
    };
    EventTarget.prototype.attachEvent = function () {};
    EventTarget.prototype.detachEvent = function () {};
    EventTarget.prototype.dispatchEvent = function (event) {
        event.target = event.target || this;
        if (event.type === "react-invokeguardedcallback") {
            if (this._react_callback) {
                for (const callback of this._react_callback.slice())
                    callback(event);
            }
            return !event.defaultPrevented;
        }

        const path = [];
        let node = this;
        while (node) {
            path.push(node);
            node = node.parentNode;
        }

        event.eventPhase = 2;
        for (const current of path) {

            event.currentTarget = current;
            const listeners = current.event_listeners && current.event_listeners[event.type];
            if (listeners) {
                for (const entry of listeners.slice()) {
                    if (entry.once)
                        current.removeEventListener(event.type, entry.listener);
                    if (typeof entry.listener === "function")
                        entry.listener.call(current, event);
                    else if (entry.listener && typeof entry.listener.handleEvent === "function")
                        entry.listener.handleEvent(event);
                    if (event._stopImmediate)
                        break;
                }
            }
            const handler = current["on" + event.type];
            if (typeof handler === "function")
                handler.call(current, event);
            if (event._stopImmediate || event._stopPropagation)
                break;
        }
        event.eventPhase = 0;
        return !event.defaultPrevented;
    };
    g.EventTarget = EventTarget;
    const eventTargetPrototype = EventTarget.prototype;

    class Node extends EventTarget {
        constructor(nodeType = 0, nodeName = "") {
            super();
            this.nodeType = nodeType;
            this.nodeName = nodeName;
            this.parentNode = null;
            this.previousSibling = null;
            this.nextSibling = null;
            this.firstChild = null;
            this.lastChild = null;
            this._childrenVersion = 0;
        }
        get ownerDocument() { return g.document; }
        get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
        get childNodes() {
            const result = [];
            let child = this.firstChild;
            while (child) {
                result.push(child);
                child = child.nextSibling;
            }
            return result;
        }
        get isConnected() {
            let node = this;
            while (node.parentNode)
                node = node.parentNode;
            return node === g.document;
        }
        appendChild(child) {
            if (child.nodeType === 11) { // DocumentFragment
                for (const grandchild of child.childNodes.slice())
                    this.appendChild(grandchild);
                return child;
            }
            if (child.parentNode)
                child.parentNode.removeChild(child);
            if (!this.firstChild) {
                this.firstChild = child;
                this.lastChild = child;
            } else {
                child.previousSibling = this.lastChild;
                this.lastChild.nextSibling = child;
                this.lastChild = child;
            }
            child.parentNode = this;
            child.nextSibling = null;
            this._childrenVersion++;
            notifyMutation(this, "childList", [child], []);
            if (this.nodeType === 1 && child.nodeType === 1)
                this._invalidateLayout();
            return child;
        }
        insertBefore(child, reference) {
            if (!reference)
                return this.appendChild(child);
            if (child.parentNode)
                child.parentNode.removeChild(child);
            child.nextSibling = reference;
            child.previousSibling = reference.previousSibling;
            if (reference.previousSibling)
                reference.previousSibling.nextSibling = child;
            else
                this.firstChild = child;
            reference.previousSibling = child;
            child.parentNode = this;
            this._childrenVersion++;
            notifyMutation(this, "childList", [child], []);
            if (this.nodeType === 1)
                this._childrenVersion++;
            return child;
        }
        removeChild(child) {
            if (child.previousSibling)
                child.previousSibling.nextSibling = child.nextSibling;
            else
                this.firstChild = child.nextSibling;
            if (child.nextSibling)
                child.nextSibling.previousSibling = child.previousSibling;
            else
                this.lastChild = child.previousSibling;
            child.parentNode = null;
            child.previousSibling = null;
            child.nextSibling = null;
            this._childrenVersion++;
            notifyMutation(this, "childList", [], [child]);
            if (this.nodeType === 1)
                this._childrenVersion++;
            return child;
        }
        replaceChild(newChild, oldChild) {
            this.insertBefore(newNode, oldChild);
            this.removeChild(oldChild);
            return oldChild;
        }
        remove() {
            if (this.parentNode)
                this.parentNode.removeChild(this);
        }
        append(...nodes) {
            for (const node of nodes)
                this.appendChild(typeof node === "string" ? g.document.createTextNode(node) : node);
        }
        prepend(...nodes) {
            const first = this.firstChild;
            for (const node of nodes)
                this.insertBefore(typeof node === "string" ? g.document.createTextNode(node) : node, first);
        }
        before(...nodes) {
            const parent = this.parentNode;
            if (!parent)
                return;
            for (const node of nodes)
                parent.insertBefore(typeof node === "string" ? g.document.createTextNode(node) : node, this);
        }
        after(...nodes) {
            const parent = this.parentNode;
            if (!parent)
                return;
            const next = this.nextSibling;
            for (const node of nodes)
                parent.insertBefore(typeof node === "string" ? g.document.createTextNode(node) : node, next);
        }
        contains(node) {
            for (let current = node; current; current = current.parentNode) {
                if (current === this)
                    return true;
            }
            return false;
        }
        getRootNode() {
            let node = this;
            while (node.parentNode)
                node = node.parentNode;
            return node;
        }
        cloneNode(deep = false) {
            let clone;
            if (this.nodeType === 3)
                clone = g.document.createTextNode(this.data);
            else if (this.nodeType === 8)
                clone = g.document.createComment(this.data);
            else if (this.nodeType === 1) {
                clone = g.document.createElement(this.tagName.toLowerCase());
                for (const name of this.getAttributeNames())
                    clone.setAttribute(name, this.getAttribute(name));
                clone._style = { ...this._style };
            } else {
                clone = this.constructor ? new this.constructor() : new Node();
            }
            if (deep) {
                for (const child of this.childNodes)
                    clone.appendChild(child.cloneNode(true));
            }
            return clone;
        }
        compareDocumentPosition(other) {
            return g.Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC;
        }
        get textContent() {
            return this.childNodes.map((child) => child.textContent).join("");
        }
        set textContent(value) {
            while (this.firstChild)
                this.removeChild(this.firstChild);
            if (value !== "" && value != null)
                this.appendChild(g.document.createTextNode(String(value)));
        }
        get nodeValue() { return null; }
        set nodeValue(value) {}
        _invalidateLayout() {
            elementOrderCache = null;
        }
    }
    Node.ELEMENT_NODE = 1;
    Node.ATTRIBUTE_NODE = 2;
    Node.TEXT_NODE = 3;
    Node.CDATA_SECTION_NODE = 4;
    Node.ENTITY_REFERENCE_NODE = 5;
    Node.ENTITY_NODE = 6;
    Node.PROCESSING_INSTRUCTION_NODE = 7;
    Node.COMMENT_NODE = 8;
    Node.DOCUMENT_NODE = 9;
    Node.DOCUMENT_TYPE_NODE = 10;
    Node.DOCUMENT_FRAGMENT_NODE = 11;
    Node.NOTATION_NODE = 12;
    Node.DOCUMENT_POSITION_DISCONNECTED = 1;
    Node.DOCUMENT_POSITION_PRECEDING = 2;
    Node.DOCUMENT_POSITION_FOLLOWING = 4;
    Node.DOCUMENT_POSITION_CONTAINS = 8;
    Node.DOCUMENT_POSITION_CONTAINED_BY = 16;
    Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 32;
    g.Node = Node;

    // Keep the real EventTarget prototype, with addEventListener and
    // friends, so Hyperion can intercept those methods once instead of
    // adding a pending wrapper for every DOM node it sees.

    class CharacterData extends Node {
        constructor(data = "") {
            super(3, "#text");
            this.data = data;
            this.nodeValue = data;
        }
        get textContent() { return this.data; }
        set textContent(value) { this.data = this.nodeValue = String(value); }
        get length() { return this.data.length; }
    }
    class Text extends CharacterData {
        constructor(data = "") {
            super(data);
            this.nodeType = 3;
            this.nodeName = "#text";
        }
    }
    class Comment extends CharacterData {
        constructor(data = "") {
            super(data);
            this.nodeType = 8;
            this.nodeName = "#comment";
        }
    }
    class DocumentFragment extends Node {
        constructor() {
            super(11, "#document-fragment");
        }
    }
    g.CharacterData = CharacterData;
    g.Text = Text;
    g.Comment = Comment;
    g.DocumentFragment = DocumentFragment;

    function styleProxy(element) {
        if (!element._style)
            element._style = Object.create(null);
        if (element._styleProxy)
            return element._styleProxy;
        const update = (name, value) => {
            element._style[name] = value;
            notifyMutation(element, "attributes", [], [], "style");
        };
        const proxy = new Proxy({}, {
            get(target, property) {
                if (property === "getPropertyValue")
                    return (name) => element._style[propertyName(name)] ?? "";
                if (property === "setProperty")
                    return (name, value) => { element._style[property] = value; notifyMutation(element, "attributes", [], [], "style"); };
                if (property === "removeProperty")
                    return (name) => { const old = element._style[property]; delete element._style[property]; notifyMutation(element, "attributes", [], [], "style"); return old ?? ""; };
                if (property === "cssText")
                    return Object.entries(element._style).map(([name, value]) => `${name}: ${value};`).join(" ");
                if (property === "getPropertyPriority")
                    return () => "";
                if (property === "item")
                    return (index) => Object.keys(element._style)[index] ?? "";
                if (property === "length")
                    return Object.keys(element._style).length;
                if (property === "parentRule")
                    return null;
                return element._style[property] ?? element._style[cssPropertyName(property)] ?? "";
            },
            set(target, property, value) {
                update(property, String(value));
                return true;
            },
            has(target, property) {
                return property in element._style;
            },
            ownKeys() {
                return Object.keys(element._style);
            },
            getOwnPropertyDescriptor(target, property) {
                if (property in element._style)
                    return { configurable: true, enumerable: true, value: element._style[property] };
                return undefined;
            },
        });
        element._styleProxy = proxy;
        return proxy;
    }

    function cssPropertyName(name) {
        if (name === "float")
            return "cssFloat";
        if (name.startsWith("--"))
            return name;
        return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    }
    function propertyName(name) {
        if (name === "cssFloat")
            return "float";
        return name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
    }

    let elementOrderCache = null;
    function allElements() {
        if (elementOrderCache)
            return elementOrderCache;
        const result = [];
        const stack = [g.document.documentElement];
        while (stack.length) {
            const element = stack.pop();
            if (!element)
                continue;
            result.push(element);
            const children = element.childNodes;
            for (let i = children.length - 1; i >= 0; i--) {
                if (children[i].nodeType === 1)
                    stack.push(children[i]);
            }
        }
        elementOrderCache = result;
        return result;
    }

    function elementsInSubtree(root) {
        const result = [];
        const stack = [];
        for (let i = root.childNodes.length - 1; i >= 0; i--)
            stack.push(root.childNodes[i]);
        while (stack.length) {
            const node = stack.pop();
            if (node.nodeType !== 1)
                continue;
            result.push(node);
            for (let i = node.childNodes.length - 1; i >= 0; i--)
                stack.push(node.childNodes[i]);
        }
        return result;
    }

    function querySelectorAll(root, selector) {
        const alternatives = parseSelector(selector);
        const elements = elementsInSubtree(root);
        const result = [];
        currentScope = root;
        for (const element of elements) {
            outer:
            for (const parts of alternatives) {
                if (parts.length && matchSelectorParts(element, parts, parts.length - 1)) {
                    result.push(element);
                    break outer;
                }
            }
        }
        currentScope = null;
        return result;
    }

    function querySelector(root, selector) {
        const result = querySelectorAll(root, selector);
        return result[0] || null;
    }

    class Element extends Node {
        constructor(tagName) {
            super(1, String(tagName).toUpperCase());
            this.tagName = String(tagName).toUpperCase();
            this.localName = String(tagName).toLowerCase();
            this._attributes = Object.create(null);
            this._style = Object.create(null);
            this._styleProxy = null;
            this.scrollTopValue = 0;
            this.scrollLeftValue = 0;
            // React probes for focusin support before using its legacy
            // attachEvent fallback.
            this.onfocusin = null;
            this.onfocusout = null;
        }
        get shadowRoot() { return null; }
        attachShadow() { return null; }
        get namespaceURI() { return "http://www.w3.org/1999/xhtml"; }
        get attributes() {
            return this.getAttributeNames().map((name) => ({ name, value: this.getAttribute(name) }));
        }
        getAttributeNames() {
            const names = Object.keys(this._attributes);
            if (Object.keys(this._style).length && !names.includes("style"))
                names.push("style");
            return names;
        }
        getAttribute(name) {
            name = String(name).toLowerCase();
            if (name === "style") {
                const style = styleProxy(this).cssText;
                return style || null;
            }
            return Object.prototype.hasOwnProperty.call(this._attributes, name) ? this._attributes[name] : null;
        }
        setAttribute(name, value) {
            name = String(name).toLowerCase();
            if (name === "style") {
                this._style = Object.create(null);
                for (const declaration of String(value).split(";")) {
                    const index = declaration.indexOf(":");
                    if (index !== -1) {
                        const property = declaration.slice(0, index).trim();
                        const propertyValue = declaration.slice(index + 1).trim();
                        if (property)
                            this._style[cssPropertyName(property)] = propertyValue;
                    }
                }
            } else {
                this._attributes[name] = String(value);
            }
            notifyMutation(this, "attributes", [], [], name);
        }
        removeAttribute(name) {
            name = String(name).toLowerCase();
            if (name === "style")
                this._style = Object.create(null);
            else
                delete this._attributes[name];
            notifyMutation(this, "attributes", [], [], name);
        }
        hasAttribute(name) {
            name = String(name).toLowerCase();
            return name === "style" ? Object.keys(this._style).length > 0 : Object.prototype.hasOwnProperty.call(this._attributes, name);
        }
        toggleAttribute(name, force) {
            const present = this.hasAttribute(name);
            const next = force === undefined ? !present : !!force;
            if (next && !present)
                this.setAttribute(name, "");
            else if (!next && present)
                this.removeAttribute(name);
            return next;
        }
        get id() { return this.getAttribute("id") || ""; }
        set id(value) { this.setAttribute("id", value); }
        get className() { return this.getAttribute("class") || ""; }
        set className(value) { this.setAttribute("class", value); }
        get classList() {
            const element = this;
            return {
                add(...names) {
                    const classes = getClasses(element);
                    for (const name of names)
                        if (!classes.includes(name))
                            classes.push(name);
                    element.setAttribute("class", classes.join(" "));
                },
                remove(...names) {
                    element.setAttribute("class", getClasses(element).filter((name) => !names.includes(name)).join(" "));
                },
                contains(name) { return getClasses(element).includes(name); },
                toggle(name, force) {
                    const present = getClasses(element).includes(name);
                    const next = force === undefined ? !present : !!force;
                    if (next)
                        this.add(name);
                    else
                        this.remove(name);
                    return next;
                },
                replace(oldName, newName) {
                    const classes = getClasses(element);
                    const index = classes.indexOf(oldName);
                    if (index === -1)
                        return false;
                    classes[index] = newName;
                    element.setAttribute("class", classes.join(" "));
                    return true;
                },
                item(index) { return getClasses(element)[index] || null; },
                get length() { return getClasses(element).length; },
                [Symbol.iterator]() { return getClasses(element)[Symbol.iterator](); },
            };
        }
        get dataset() {
            const element = this;
            return new Proxy({}, {
                get(target, property) {
                    return element.getAttribute("data-" + propertyName(property));
                },
                set(target, property, value) {
                    element.setAttribute("data-" + propertyName(property), value);
                    return true;
                },
                has(target, property) {
                    return element.hasAttribute("data-" + propertyName(property));
                },
                deleteProperty(target, property) {
                    element.removeAttribute("data-" + propertyName(property));
                    return true;
                },
            });
        }
        get style() { return styleProxy(this); }
        set style(value) {
            if (typeof value === "string")
                this.setAttribute("style", value);
        }
        get innerHTML() {
            if (this.tagName === "SCRIPT")
                return this.textContent;
            return this.childNodes.map((child) => serializeNode(child)).join("");
        }
        set innerHTML(html) {
            if (this.tagName === "SCRIPT") {
                this.textContent = String(html);
                return;
            }
            while (this.firstChild)
                this.removeChild(this.firstChild);
            parseHTMLInto(this, String(html));
        }
        get outerHTML() { return serializeNode(this); }
        insertAdjacentHTML(position, html) {
            position = String(position).toLowerCase();
            const container = g.document.createElement("div");
            container.innerHTML = html;
            if (position === "beforeend") {
                for (const child of container.childNodes.slice())
                    this.appendChild(child);
            } else if (position === "afterbegin") {
                const first = this.firstChild;
                for (const child of container.childNodes.slice())
                    this.insertBefore(child, first);
            } else if (position === "beforebegin" && this.parentNode) {
                for (const child of container.childNodes.slice())
                    this.parentNode.insertBefore(child, this);
            } else if (position === "afterend" && this.parentNode) {
                const next = this.nextSibling;
                for (const child of container.childNodes.slice())
                    this.parentNode.insertBefore(child, next);
            }
        }
        get children() {
            return this.childNodes.filter((node) => node.nodeType === 1);
        }
        get firstElementChild() { return this.children[0] || null; }
        get lastElementChild() {
            const children = this.children;
            return children[children.length - 1] || null;
        }
        get childElementCount() { return this.children.length; }
        get previousElementSibling() {
            let node = this.previousSibling;
            while (node && node.nodeType !== 1)
                node = node.previousSibling;
            return node;
        }
        get nextElementSibling() {
            let node = this.nextSibling;
            while (node && node.nodeType !== 1)
                node = node.nextSibling;
            return node;
        }
        get textContent() {
            return this.childNodes.map((child) => child.textContent).join("");
        }
        set textContent(value) {
            while (this.firstChild)
                this.removeChild(this.firstChild);
            if (value !== "" && value != null)
                this.appendChild(g.document.createTextNode(String(value)));
        }
        get innerText() { return this.textContent; }
        set innerText(value) { this.textContent = value; }
        getElementsByTagName(name) {
            name = String(name).toLowerCase();
            return elementsInSubtree(this).filter((element) => name === "*" || element.tagName.toLowerCase() === name);
        }
        getElementsByClassName(name) {
            return elementsInSubtree(this).filter((element) => getClasses(element).includes(name));
        }
        getElementsByName(name) {
            return elementsInSubtree(this).filter((element) => element.getAttribute("name") === name);
        }
        querySelector(selector) { return querySelector(this, selector); }
        querySelectorAll(selector) { return querySelectorAll(this, selector); }
        matches(selector) { return matchSelector(this, selector); }
        webkitMatchesSelector(selector) { return this.matches(selector); }
        closest(selector) {
            let element = this;
            while (element) {
                if (element.nodeType === 1 && matchSelector(element, selector))
                    return element;
                element = element.parentNode;
            }
            return null;
        }
        get nextSiblingElement() { return this.nextElementSibling; }
        get firstChildElement() { return this.firstElementChild; }
        get offsetHeight() { return this.getBoundingClientRect().height; }
        get offsetWidth() { return this.getBoundingClientRect().width; }
        get offsetTop() { return this.getBoundingClientRect().top + (g.scrollY || 0); }
        get offsetLeft() { return this.getBoundingClientRect().left; }
        get clientHeight() { return this.getBoundingClientRect().height; }
        get clientWidth() { return this.getBoundingClientRect().width; }
        get clientTop() { return 0; }
        get clientLeft() { return 0; }
        get scrollHeight() {
            if (this.hasAttribute("data-feed-position") || this.getAttribute("data-testid") === "post-dialog-body")
                return Math.max(this.getBoundingClientRect().height, 2000);
            return this.getBoundingClientRect().height;
        }
        get scrollWidth() { return this.getBoundingClientRect().width; }
        get scrollTop() { return this.scrollTopValue; }
        set scrollTop(value) {
            this.scrollTopValue = Number(value) || 0;
            notifyScroll(this);
        }
        get scrollLeft() { return this.scrollLeftValue; }
        set scrollLeft(value) {
            this.scrollLeftValue = Number(value) || 0;
            notifyScroll(this);
        }
        scrollTo(optionsOrX, y) {
            if (typeof optionsOrX === "object") {
                if ("top" in optionsOrX)
                    this.scrollTop = optionsOrX.top;
                if ("left" in optionsOrX)
                    this.scrollLeft = optionsOrX.left;
            } else {
                this.scrollLeft = optionsOrX;
                this.scrollTop = y;
            }
            notifyScroll(this);
        }
        scrollBy(optionsOrX, y) {
            if (typeof optionsOrX === "object")
                this.scrollTo({ top: this.scrollTop + (optionsOrX.top || 0), left: this.scrollLeft + (optionsOrX.left || 0) });
            else
                this.scrollTo(this.scrollLeft + optionsOrX, this.scrollTop + y);
        }
        scrollIntoView(options = {}) {
            const rect = this.getBoundingClientRect();
            const top = rect.top + (g.scrollY || 0);
            const height = g.innerHeight || 815;
            let target = top;
            if (options.block === "center")
                target = top - (height - rect.height) / 2;
            else if (options.block === "end" || options.block === "nearest")
                target = top + rect.height - height;
            else
                target = top;
            g.scrollY = Math.max(0, Math.round(target));
            notifyScroll(g.document);
        }
        getBoundingClientRect() {
            return getBoundingClientRect(this);
        }
        getClientRects() {
            return [this.getBoundingClientRect()];
        }
        focus(options) {
            g.document.activeElement = this;
            this._focused = true;
            if (this.isContentEditable)
                setSelectionAtEnd(this);
            notifyFocus(this, "focus");
        }
        blur() {
            if (g.document.activeElement === this)
                g.document.activeElement = g.document.body;
            this._focused = false;
            notifyFocus(this, "blur");
        }
        click() {
            return this.dispatchEvent(new g.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
        }
        getBoundingClientRectForDebug() { return getBoundingClientRect(this); }
        getAttributeNode(name) {
            const value = this.getAttribute(name);
            return value === null ? null : { name, value };
        }
        setAttributeNode(attribute) {
            this.setAttribute(attribute.name, attribute.value);
            return attribute;
        }
        removeAttributeNode(attribute) {
            this.removeAttribute(attribute.name);
            return attribute;
        }
        hasFocus() { return g.document.activeElement === this; }
        get contentEditable() { return this.getAttribute("contenteditable") || "inherit"; }
        set contentEditable(value) { this.setAttribute("contenteditable", value); }
        get isContentEditable() {
            let element = this;
            while (element) {
                const value = element.getAttribute && element.getAttribute("contenteditable");
                if (value === "true" || value === "")
                    return true;
                if (value === "false")
                    return false;
                element = element.parentElement;
            }
            return false;
        }
        get tabIndex() { return Number(this.getAttribute("tabindex") ?? 0); }
        set tabIndex(value) { this.setAttribute("tabindex", String(value)); }
    }

    function serializeNode(node) {
        if (node.nodeType === 3)
            return node.data;
        if (node.nodeType === 8)
            return `<!--${node.data}-->`;
        if (node.nodeType !== 1)
            return node.textContent;
        const tag = node.tagName.toLowerCase();
        let result = `<${tag}`;
        for (const name of node.getAttributeNames())
            result += ` ${name}="${node.getAttribute(name).replace(/"/g, "&quot;")}"`;
        result += ">";
        result += node.childNodes.map(serializeNode).join("");
        result += `</${tag}>`;
        return result;
    }

    function parseHTMLInto(root, html) {
        let i = 0;
        const stack = [root];
        const appendText = (text) => {
            if (text)
                stack[stack.length - 1].appendChild(g.document.createTextNode(text));
        };
        while (i < html.length) {
            const lt = html.indexOf("<", i);
            if (lt === -1) {
                appendText(html.slice(i));
                break;
            }
            appendText(html.slice(i, lt));
            if (html.startsWith("<!--", lt)) {
                const end = html.indexOf("-->", lt + 4);
                const data = html.slice(lt + 4, end === -1 ? html.length : end);
                stack[stack.length - 1].appendChild(g.document.createComment(data));
                i = end === -1 ? html.length : end + 3;
                continue;
            }
            const gt = findTagEnd(html, lt + 1);
            if (gt === -1) {
                appendText(html.slice(lt));
                break;
            }
            const body = html.slice(lt + 1, gt).trim();
            if (body.startsWith("/")) {
                if (stack.length > 1)
                    stack.pop();
                i = gt + 1;
                continue;
            }
            const selfClosing = body.endsWith("/");
            const tagName = body.split(/\s+/)[0].replace(/\/$/, "");
            const element = g.document.createElement(tagName);
            const attrText = body.slice(tagName.length).replace(/\/$/, "");
            const attrPattern = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g;
            let match;
            while ((match = attrPattern.exec(attrText)))
                element.setAttribute(match[1], match[2] ?? match[3] ?? match[4] ?? "");
            stack[stack.length - 1].appendChild(element);
            if (!selfClosing && !["br", "hr", "img", "input", "meta", "link", "source"].includes(tagName.toLowerCase()))
                stack.push(element);
            i = gt + 1;
        }
    }

    function findTagEnd(html, start) {
        let quote = null;
        for (let i = start; i < html.length; i++) {
            const ch = html[i];
            if (quote) {
                if (ch === quote)
                    quote = null;
            } else if (ch === '"' || ch === "'") {
                quote = ch;
            } else if (ch === ">") {
                return i;
            }
        }
        return -1;
    }

    g.Element = Element;

    function getOrderIndex(element) {
        const all = allElements();
        return all.indexOf(element);
    }

    function getBoundingClientRect(element) {
        const scrollY = g.scrollY || 0;
        const viewportHeight = g.innerHeight || 815;
        let top = 0;
        let height = 40;
        let width = 1200;
        const feedPosition = element.getAttribute && element.getAttribute("data-feed-position");
        const testId = element.getAttribute && element.getAttribute("data-testid");
        const inDialog = element.closest && element.closest('[data-testid="post-dialog"]') !== null;
        if (element === g.document.documentElement) {
            height = 3000;
            width = 1440;
        } else if (element === g.document.body) {
            height = Math.max(3000, feedUnitCount() * 480 + 400);
            width = 1440;
        } else if (element === g.document.getElementById("root")) {
            top = 56;
            height = Math.max(2000, feedUnitCount() * 480 + 300);
            width = 1440;
        } else if (feedPosition !== null) {
            top = 120 + Number(feedPosition) * 480;
            height = 450;
            width = 590;
        } else if (testId === "feed-sentinel") {
            top = 120 + feedUnitCount() * 480;
            height = 1;
            width = 590;
        } else if (testId === "comments-sentinel") {
            const body = element.closest('[data-testid="post-dialog-body"]');
            top = body && body.scrollTopValue > 0 ? 549 : 700;
            height = 1;
            width = 590;
        } else if (testId === "post-dialog" || element.getAttribute("role") === "dialog") {
            top = 100;
            height = 600;
            width = 700;
        } else if (testId === "post-dialog-body") {
            top = 150;
            height = 400;
            width = 700;
        } else {
            const index = getOrderIndex(element);
            top = 56 + (index % 200) * 24;
            height = 24;
            width = 300;
        }
        // Elements inside a scroll container move with that container. The
        // dialog is fixed over the page, so the page scroll does not move it.
        if (testId !== "comments-sentinel") {
            for (let ancestor = element.parentNode; ancestor; ancestor = ancestor.parentNode) {
                if (ancestor.nodeType === 1)
                    top -= ancestor.scrollTopValue || 0;
            }
        }
        const pageScroll = inDialog ? 0 : scrollY;
        return {
            x: 0,
            y: top - pageScroll,
            top: top - pageScroll,
            bottom: top + height - pageScroll,
            left: 0,
            right: width,
            width,
            height,
            toJSON() { return this; },
        };
    }

    function feedUnitCount() {
        return allElements().filter((element) => element.hasAttribute && element.hasAttribute("data-feed-position")).length;
    }

    // ------------------------------------------------------------------
    // Events

    class Event {
        constructor(type, init = {}) {
            this.type = String(type);
            this.bubbles = !!init.bubbles;
            this.cancelable = !!init.cancelable;
            this.composed = !!init.composed;
            this.target = null;
            this.currentTarget = null;
            this.defaultPrevented = false;
            this._stopPropagation = false;
            this._stopImmediate = false;
            this.eventPhase = 0;
            this.timeStamp = g.performance.now();
            this.isTrusted = false;
            this.returnValue = true;
            this.detail = init.detail;
            this.view = init.view || g;
            Object.assign(this, init);
        }
        preventDefault() {
            if (this.cancelable)
                this.defaultPrevented = true;
            this.returnValue = false;
        }
        stopPropagation() { this._stopPropagation = true; }
        stopImmediatePropagation() {
            this._stopPropagation = true;
            this._stopImmediate = true;
        }
        initEvent(type, bubbles, cancelable) {
            this.type = type;
            this.bubbles = !!bubbles;
            this.cancelable = !!cancelable;
        }
        initCustomEvent(type, bubbles, cancelable, detail) {
            this.initEvent(type, bubbles, cancelable);
            this.detail = detail;
        }
        composedPath() {
            const result = [];
            for (let node = this.target; node; node = node.parentNode)
                result.push(node);
            return result;
        }
    }
    class CustomEvent extends Event {
        constructor(type, init = {}) { super(type, init); this.detail = init.detail; }
    }
    class UIEvent extends Event {
        constructor(type, init = {}) { super(type, init); this.detail = init.detail ?? 0; }
    }
    class MouseEvent extends UIEvent {
        constructor(type, init = {}) {
            super(type, init);
            this.button = init.button ?? 0;
            this.buttons = init.buttons ?? 0;
            this.clientX = init.clientX ?? 0;
            this.clientY = init.clientY ?? 0;
            this.screenX = init.screenX ?? 0;
            this.screenY = init.screenY ?? 0;
            this.ctrlKey = !!init.ctrlKey;
            this.shiftKey = !!init.shiftKey;
            this.altKey = !!init.altKey;
            this.metaKey = !!init.metaKey;
            this.relatedTarget = init.relatedTarget ?? null;
        }
    }
    class PointerEvent extends MouseEvent {
        constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? ""; this.isPrimary = init.isPrimary ?? true; }
    }
    class KeyboardEvent extends UIEvent {
        constructor(type, init = {}) {
            super(type, init);
            this.key = init.key ?? "";
            this.code = init.code ?? "";
            this.keyCode = init.keyCode ?? (this.key.length === 1 ? this.key.toUpperCase().charCodeAt(0) : 0);
            this.which = this.keyCode;
            this.ctrlKey = !!init.ctrlKey;
            this.shiftKey = !!init.shiftKey;
            this.altKey = !!init.altKey;
            this.metaKey = !!init.metaKey;
            this.repeat = !!init.repeat;
            this.isComposing = !!init.isComposing;
        }
    }
    class InputEvent extends UIEvent {
        constructor(type, init = {}) { super(type, init); this.data = init.data ?? null; this.inputType = init.inputType ?? ""; this.isComposing = !!init.isComposing; }
    }
    // Lexical only registers a native beforeinput listener when InputEvent
    // advertises getTargetRanges(). Providing it lets editing take the same
    // path as a browser instead of relying on the input fallback.
    InputEvent.prototype.getTargetRanges = function () {
        const selection = g.document && g.document.getSelection();
        if (!selection || !selection.rangeCount)
            return [];
        return [selection.getRangeAt(0)];
    };
    class FocusEvent extends UIEvent {
        constructor(type, init = {}) { super(type, init); this.relatedTarget = init.relatedTarget ?? null; }
    }
    class CompositionEvent extends UIEvent {
        constructor(type, init = {}) { super(type, init); this.data = init.data ?? ""; }
    }
    class WheelEvent extends MouseEvent {
        constructor(type, init = {}) { super(type, init); this.deltaX = init.deltaX ?? 0; this.deltaY = init.deltaY ?? 0; this.deltaZ = init.deltaZ ?? 0; this.deltaMode = init.deltaMode ?? 0; }
    }
    class DragEvent extends MouseEvent {
        constructor(type, init = {}) { super(type, init); this.dataTransfer = init.dataTransfer ?? null; }
    }
    class ClipboardEvent extends Event {
        constructor(type, init = {}) { super(type, init); this.clipboardData = init.clipboardData ?? null; }
    }
    class ErrorEvent extends Event {
        constructor(type, init = {}) { super(type, init); this.message = init.message ?? ""; this.error = init.error ?? null; }
    }
    Object.assign(g, { Event, CustomEvent, UIEvent, MouseEvent, PointerEvent, KeyboardEvent, InputEvent, FocusEvent, CompositionEvent, WheelEvent, DragEvent, ClipboardEvent, ErrorEvent });

    function notifyFocus(element, type) {
        element.dispatchEvent(new FocusEvent(type, { bubbles: type === "focusin", relatedTarget: null }));
        if (type === "focus")
            element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    }

    // ------------------------------------------------------------------
    // Observers

    class MutationObserver {
        constructor(callback) {
            this.callback = callback;
            this.records = [];
            this.targets = [];
            this.scheduled = false;
            mutationObservers.push(this);
        }
        observe(target, options = {}) {
            this.targets.push({ target, options });
        }
        disconnect() {
            this.targets = [];
            this.records = [];
            const index = mutationObservers.indexOf(this);
            if (index !== -1)
                mutationObservers.splice(index, 1);
        }
        takeRecords() {
            const records = this.records;
            this.records = [];
            return records;
        }
        _enqueue(record) {
            if (!this.targets.length)
                return;
            if (!this.targets.some(({ target }) => target.contains(record.target) || target === record.target))
                return;
            this.records.push(record);
            if (this.scheduled)
                return;
            this.scheduled = true;
            g.setTimeout(() => {
                this.scheduled = false;
                const records = this.takeRecords();
                if (records.length)
                    this.callback(records, this);
            }, 0);
        }
    }

    function parseMargin(margin) {
        const values = String(margin || "0px").trim().split(/\s+/).map((value) => parseFloat(value) || 0);
        while (values.length < 4)
            values.push(values.length === 1 ? values[0] : 0);
        return { top: values[0], right: values[1], bottom: values[2], left: values[3] };
    }

    function intersectionEntry(target, observer) {
        const rect = getBoundingClientRect(target);
        const margin = parseMargin(observer.rootMargin);
        const rootRect = observer.root && observer.root.nodeType === 1 ? getBoundingClientRect(observer.root) : null;
        const rootTop = rootRect ? rootRect.top : 0;
        const rootBottom = rootRect ? rootRect.bottom : g.innerHeight || 815;
        const rootLeft = rootRect ? rootRect.left : 0;
        const rootRight = rootRect ? rootRect.right : g.innerWidth || 1440;
        const isIntersecting = rect.bottom >= rootTop - margin.top && rect.top <= rootBottom + margin.bottom && rect.right >= rootLeft - margin.left && rect.left <= rootRight + margin.right;
        return {
            target,
            isIntersecting,
            intersectionRatio: isIntersecting ? 1 : 0,
            boundingClientRect: rect,
            intersectionRect: isIntersecting ? rect : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
            rootBounds: { top: rootTop, bottom: rootBottom, left: rootLeft, right: rootRight, width: rootRight - rootLeft, height: rootBottom - rootTop },
            time: g.performance.now(),
        };
    }

    class IntersectionObserver {
        constructor(callback, options = {}) {
            this.callback = callback;
            this.root = options.root ?? null;
            this.rootMargin = options.rootMargin ?? "0px";
            this.thresholds = Array.isArray(options.threshold) ? options.threshold : [options.threshold ?? 0];
            this.targets = new Set();
            this.scheduled = false;
            intersectionObservers.add(this);
        }
        observe(target) {
            this.targets.add(target);
            this._schedule();
        }
        unobserve(target) { this.targets.delete(target); }
        disconnect() {
            this.targets.clear();
            intersectionObservers.delete(this);
        }
        takeRecords() { return []; }
        _schedule() {
            if (this.scheduled)
                return;
            this.scheduled = true;
            g.setTimeout(() => {
                this.scheduled = false;
                if (!this.targets.size)
                    return;
                const entries = [...this.targets].map((target) => intersectionEntry(target, this));
                this.callback(entries, this);
            }, 0);
        }
    }

    class ResizeObserver {
        constructor(callback) {
            this.callback = callback;
            this.targets = new Set();
            resizeObservers.add(this);
        }
        observe(target) {
            this.targets.add(target);
            g.setTimeout(() => {
                if (this.targets.has(target)) {
                    const rect = getBoundingClientRect(target);
                    this.callback([{ target, contentRect: rect, borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }], contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }] }], this);
                }
            }, 0);
        }
        unobserve(target) { this.targets.delete(target); }
        disconnect() {
            this.targets.clear();
            resizeObservers.delete(this);
        }
    }

    g.MutationObserver = MutationObserver;
    g.IntersectionObserver = IntersectionObserver;
    g.ResizeObserver = ResizeObserver;

    g.NodeFilter = {
        FILTER_ACCEPT: 1,
        FILTER_REJECT: 2,
        FILTER_SKIP: 3,
        SHOW_ALL: 0xffffffff,
        SHOW_ELEMENT: 0x1,
        SHOW_ATTRIBUTE: 0x2,
        SHOW_TEXT: 0x4,
        SHOW_CDATA_SECTION: 0x8,
        SHOW_ENTITY_REFERENCE: 0x10,
        SHOW_ENTITY: 0x20,
        SHOW_PROCESSING_INSTRUCTION: 0x40,
        SHOW_COMMENT: 0x80,
        SHOW_DOCUMENT: 0x100,
        SHOW_DOCUMENT_TYPE: 0x200,
        SHOW_DOCUMENT_FRAGMENT: 0x400,
        SHOW_NOTATION: 0x800,
    };

    class TreeWalker {
        constructor(root, whatToShow = g.NodeFilter.SHOW_ALL, filter = null) {
            this.root = root;
            this.whatToShow = whatToShow;
            this.filter = filter;
            this.currentNode = root;
        }
        _accept(node) {
            if (!(this.whatToShow & (1 << (node.nodeType - 1))) && this.whatToShow !== g.NodeFilter.SHOW_ALL)
                return false;
            if (!this.filter)
                return true;
            const result = typeof this.filter === "function" ? this.filter(node) : this.filter.acceptNode(node);
            return result === g.NodeFilter.FILTER_ACCEPT;
        }
        _nextInTree(node) {
            if (node.firstChild)
                return node.firstChild;
            while (node && node !== this.root) {
                if (node.nextSibling)
                    return node.nextSibling;
                node = node.parentNode;
            }
            return null;
        }
        nextNode() {
            let node = this._nextInTree(this.currentNode);
            while (node && !this._accept(node))
                node = this._nextInTree(node);
            if (node)
                this.currentNode = node;
            return node;
        }
        parentNode() {
            let node = this.currentNode.parentNode;
            while (node && node !== this.root && !this._accept(node))
                node = node.parentNode;
            if (node && node !== this.root) {
                this.currentNode = node;
                return node;
            }
            return null;
        }
        firstChild() {
            let node = this.currentNode.firstChild;
            while (node && !this._accept(node))
                node = node.nextSibling;
            if (node)
                this.currentNode = node;
            return node || null;
        }
        lastChild() {
            let node = this.currentNode.lastChild;
            while (node && !this._accept(node))
                node = node.previousSibling;
            if (node)
                this.currentNode = node;
            return node || null;
        }
        previousSibling() {
            let node = this.currentNode.previousSibling;
            while (node && !this._accept(node))
                node = node.previousSibling;
            if (node)
                this.currentNode = node;
            return node || null;
        }
        nextSibling() {
            let node = this.currentNode.nextSibling;
            while (node && !this._accept(node))
                node = node.nextSibling;
            if (node)
                this.currentNode = node;
            return node || null;
        }
        previousNode() {
            let node = this.currentNode;
            while (node && node !== this.root) {
                if (node.previousSibling) {
                    node = node.previousSibling;
                    while (node.lastChild)
                        node = node.lastChild;
                } else {
                    node = node.parentNode;
                }
                if (node && node !== this.root && this._accept(node)) {
                    this.currentNode = node;
                    return node;
                }
            }
            return null;
        }
    }
    g.TreeWalker = TreeWalker;

    function notifyScroll(target) {
        if (target === g.document || target === g) {
            g.dispatchEvent(new Event("scroll"));
        } else if (target && typeof target.dispatchEvent === "function") {
            target.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        for (const observer of intersectionObservers)
            observer._schedule();
    }

    function notifyLayoutObservers() {
        for (const observer of intersectionObservers)
            observer._schedule();
        for (const observer of resizeObservers) {
            for (const target of observer.targets) {
                const rect = getBoundingClientRect(target);
                g.setTimeout(() => this.callback && this.callback([], this), 0);
            }
        }
    }

    // ------------------------------------------------------------------
    // Elements and document

    class HTMLElement extends Element {
        get offsetParent() { return this.parentElement || g.document.body; }
        get title() { return this.getAttribute("title") || ""; }
        set title(value) { this.setAttribute("title", value); }
        get hidden() { return this.hasAttribute("hidden"); }
        set hidden(value) { this.toggleAttribute("hidden", !!value); }
        get draggable() { return this.getAttribute("draggable") === "true"; }
        set draggable(value) { this.setAttribute("draggable", String(!!value)); }
        get lang() { return this.getAttribute("lang") || ""; }
        set lang(value) { this.setAttribute("lang", value); }
        get dir() { return this.getAttribute("dir") || ""; }
        set dir(value) { this.setAttribute("dir", value); }
    }
    class HTMLHtmlElement extends HTMLElement {}
    class HTMLHeadElement extends HTMLElement {}
    class HTMLBodyElement extends HTMLElement {}
    class HTMLDivElement extends HTMLElement {}
    class HTMLSpanElement extends HTMLElement {}
    class HTMLParagraphElement extends HTMLElement {}
    class HTMLHeadingElement extends HTMLElement {}
    class HTMLLIElement extends HTMLElement {}
    class HTMLOListElement extends HTMLElement {}
    class HTMLUListElement extends HTMLElement {}
    class HTMLBRElement extends HTMLElement {}
    class HTMLHRElement extends HTMLElement {}
    class HTMLLabelElement extends HTMLElement {}
    class HTMLButtonElement extends HTMLElement {
        get type() { return this.getAttribute("type") || "submit"; }
        set type(value) { this.setAttribute("type", value); }
        get disabled() { return this.hasAttribute("disabled"); }
        set disabled(value) { this.toggleAttribute("disabled", !!value); }
    }
    class HTMLInputElement extends HTMLElement {
        constructor(tagName = "input") {
            super(tagName);
            this._value = "";
            this._checked = false;
            this.selectionStart = 0;
            this.selectionEnd = 0;
        }
        get type() { return this.getAttribute("type") || "text"; }
        set type(value) { this.setAttribute("type", value); }
        get value() { return this._value; }
        set value(value) {
            this._value = String(value);
            this.selectionStart = this.selectionEnd = this._value.length;
        }
        get defaultValue() { return this.getAttribute("value") || ""; }
        set defaultValue(value) { this.setAttribute("value", value); }
        get checked() { return this._checked; }
        set checked(value) { this._checked = !!value; }
        get disabled() { return this.hasAttribute("disabled"); }
        set disabled(value) { this.toggleAttribute("disabled", !!value); }
        get placeholder() { return this.getAttribute("placeholder") || ""; }
        set placeholder(value) { this.setAttribute("placeholder", value); }
        get name() { return this.getAttribute("name") || ""; }
        set name(value) { this.setAttribute("name", value); }
        select() {
            this.selectionStart = 0;
            this.selectionEnd = this._value.length;
        }
        setSelectionRange(start, end) {
            this.selectionStart = start;
            this.selectionEnd = end;
        }
    }
    class HTMLTextAreaElement extends HTMLInputElement {}
    class HTMLAnchorElement extends HTMLElement {
        get href() { return this.getAttribute("href") || ""; }
        set href(value) { this.setAttribute("href", value); }
        get protocol() { return String(this.href).split(":")[0] + ":"; }
        get pathname() { return String(this.href).replace(/^[a-z]+:\/\/[^/]*/i, "").split(/[?#]/)[0]; }
        get search() { const match = String(this.href).match(/\?[^#]*/); return match ? match[0] : ""; }
        get hash() { const match = String(this.href).match(/#.*/); return match ? match[0] : ""; }
    }
    class HTMLScriptElement extends HTMLElement {
        get src() { return this.getAttribute("src") || ""; }
        set src(value) { this.setAttribute("src", value); }
    }
    class HTMLImageElement extends HTMLElement {
        get src() { return this.getAttribute("src") || ""; }
        set src(value) { this.setAttribute("src", value); this.complete = true; this.naturalWidth = 500; this.naturalHeight = 500; }
        get alt() { return this.getAttribute("alt") || ""; }
        set alt(value) { this.setAttribute("alt", value); }
    }
    class HTMLIFrameElement extends HTMLElement {}
    class HTMLCanvasElement extends HTMLElement {
        getContext() { return { fillRect() {}, clearRect() {}, getImageData() { return { data: [] }; }, putImageData() {}, drawImage() {} }; }
        toDataURL() { return "data://"; }
    }
    class HTMLMediaElement extends HTMLElement {
        play() { return Promise.resolve(); }
        pause() {}
        load() {}
        get currentTime() { return 0; }
        set currentTime(value) {}
        get duration() { return 0; }
        get paused() { return true; }
    }
    class HTMLVideoElement extends HTMLMediaElement {}
    class HTMLAudioElement extends HTMLMediaElement {}
    class HTMLUnknownElement extends HTMLElement {}
    class SVGElement extends Element {
        get ownerSVGElement() { return this.closest("svg"); }
        get viewportElement() { return this.closest("svg"); }
    }
    class SVGSVGElement extends SVGElement {}
    class SVGImageElement extends SVGElement {}
    class SVGCircleElement extends SVGElement {}
    class SVGPathElement extends SVGElement {}
    class SVGRectElement extends SVGElement {}
    class SVGTextElement extends SVGElement {}
    class SVGGElement extends SVGElement {}
    class SVGDefsElement extends SVGElement {}
    class SVGMaskElement extends SVGElement {}
    class SVGLinearGradientElement extends SVGElement {}
    class SVGStopElement extends SVGElement {}

    const elementConstructors = {
        html: HTMLHtmlElement, head: HTMLHeadElement, body: HTMLBodyElement,
        div: HTMLDivElement, span: HTMLSpanElement, p: HTMLParagraphElement,
        h1: HTMLHeadingElement, h2: HTMLHeadingElement, h3: HTMLHeadingElement,
        h4: HTMLHeadingElement, h5: HTMLHeadingElement, h6: HTMLHeadingElement,
        li: HTMLLIElement, ol: HTMLOListElement, ul: HTMLUListElement,
        br: HTMLBRElement, hr: HTMLHRElement, label: HTMLLabelElement,
        button: HTMLButtonElement, input: HTMLInputElement,
        textarea: HTMLTextAreaElement, a: HTMLAnchorElement,
        script: HTMLScriptElement, img: HTMLImageElement,
        iframe: HTMLIFrameElement, canvas: HTMLCanvasElement,
        video: HTMLVideoElement, audio: HTMLAudioElement,
        svg: SVGSVGElement, image: SVGImageElement, circle: SVGCircleElement,
        path: SVGPathElement, rect: SVGRectElement, text: SVGTextElement,
        g: SVGGElement, defs: SVGDefsElement, mask: SVGMaskElement,
        linearGradient: SVGLinearGradientElement, stop: SVGStopElement,
    };

    function getElementConstructor(tagName) {
        const lower = String(tagName).toLowerCase();
        if (!(tagName in elementConstructors) && !(lower in elementConstructors))
            return lower.includes("-") || lower === "react" ? HTMLUnknownElement : HTMLElement;
        return elementConstructors[tagName] || elementConstructors[lower];
    }

    Object.assign(g, {
        HTMLElement, HTMLHtmlElement, HTMLHeadElement, HTMLBodyElement,
        HTMLDivElement, HTMLSpanElement, HTMLParagraphElement, HTMLHeadingElement,
        HTMLLIElement, HTMLOListElement, HTMLUListElement, HTMLBRElement,
        HTMLHRElement, HTMLLabelElement, HTMLButtonElement, HTMLInputElement,
        HTMLTextAreaElement, HTMLAnchorElement, HTMLScriptElement,
        HTMLImageElement, HTMLIFrameElement, HTMLCanvasElement,
        HTMLMediaElement, HTMLVideoElement, HTMLAudioElement, HTMLUnknownElement,
        SVGElement, SVGSVGElement, SVGImageElement, SVGCircleElement,
        SVGPathElement, SVGRectElement, SVGTextElement, SVGGElement,
        SVGDefsElement, SVGMaskElement, SVGLinearGradientElement, SVGStopElement,
    });

    function executeScriptElement(script) {
        const src = script.getAttribute("src");
        if (!src)
            return;
        const path = "dist/" + src.replace(/^\.?\//, "");
        try {
            loadFile(path);
            if (typeof script.onload === "function")
                g.setTimeout(() => script.onload({ type: "load", target: script }), 0);
        } catch (error) {
            if (typeof script.onerror === "function")
                script.onerror({ type: "error", target: script, error });
            else
                throw error;
        }
    }

    // Append scripts through Node.appendChild, but execute them only after
    // they're in the tree, as a browser would. insertBefore keeps the normal
    // insertion path and executes the script afterwards.
    const baseAppendChild = Node.prototype.appendChild;
    const baseInsertBefore = Node.prototype.insertBefore;
    Node.prototype.appendChild = function (child) {
        const result = baseAppendChild.call(this, child);
        if (child.nodeType === 1 && child.tagName === "SCRIPT" && child.getAttribute("src"))
            executeScriptElement(child);
        return result;
    };
    Node.prototype.insertBefore = function (child, reference) {
        const result = baseInsertBefore.call(this, child, reference);
        if (child.nodeType === 1 && child.tagName === "SCRIPT" && child.getAttribute("src"))
            executeScriptElement(child);
        return result;
    };

    // ------------------------------------------------------------------
    // URL, location, history, fetch

    class URLSearchParams {
        constructor(init = "") {
            this._params = [];
            if (typeof init === "string") {
                for (const pair of String(init).replace(/^\?/, "").split("&")) {
                    if (!pair)
                        continue;
                    const index = pair.indexOf("=");
                    this._params.push([
                        decodeURIComponent(index === -1 ? pair : pair.slice(0, index)),
                        decodeURIComponent(index === -1 ? "" : pair.slice(index + 1)),
                    ]);
                }
            } else if (init && typeof init[Symbol.iterator] === "function") {
                for (const [key, value] of init)
                    this.append(key, value);
            } else if (init) {
                for (const key of Object.keys(init))
                    this.append(key, init[key]);
            }
        }
        append(name, value) { this._params.push([String(name), String(value)]); }
        delete(name) { this._params = this._params.filter(([key]) => key !== name); }
        get(name) { const found = this._params.find(([key]) => key === name); return found ? found[1] : null; }
        getAll(name) { return this._params.filter(([name0]) => name0 === name).map(([, value]) => value); }
        has(name) { return this._params.some(([key]) => key === name); }
        set(name, value) {
            const index = this._params.findIndex(([key]) => name === key);
            if (index === -1)
                this.append(name, value);
            else
                this._params[index] = [String(name), String(value)];
        }
        sort() { this._params.sort((a, b) => a[0].localeCompare(b[0])); }
        keys() { return this._params.map(([name]) => name)[Symbol.iterator](); }
        values() { return this._params.map(([, value]) => value)[Symbol.iterator](); }
        entries() { return this._params[Symbol.iterator](); }
        forEach(callback, thisArg) { for (const [name, value] of this._params) callback.call(thisArg, value, name, this); }
        [Symbol.iterator]() { return this.entries(); }
        get size() { return this._params.length; }
        toString() {
            return this._params.map(([name, value]) => encodeURIComponent(name) + "=" + encodeURIComponent(value)).join("&");
        }
    }
    g.URLSearchParams = URLSearchParams;

    function resolveURL(url, base) {
        url = String(url);
        base = base === undefined ? "http://localhost/" : String(base);
        if (/^[a-z][a-z0-9+.-]*:/i.test(url))
            return url;
        if (/^[a-z][a-z0-9+.-]*:/i.test(base)) {
            const originMatch = base.match(/^([a-z][a-z0-9+.-]*:)(\/\/[^/]*)?(.*)$/i);
            const protocol = originMatch ? originMatch[1] : "";
            const host = originMatch && originMatch[2] ? originMatch[2] : "";
            const rest = originMatch ? originMatch[3] : "";
            if (url.startsWith("//"))
                return protocol + url;
            if (url.startsWith("/"))
                return protocol + host + url;
            const directory = rest.slice(0, rest.lastIndexOf("/") + 1);
            return protocol + host + normalizePath(directory + url);
        }
        if (url.startsWith("/"))
            return url;
        const directory = base.slice(0, base.lastIndexOf("/") + 1);
        return normalizePath(directory + url);
    }

    function normalizePath(path) {
        const parts = path.split("/");
        const result = [];
        for (const part of parts) {
            if (part === "..")
                result.pop();
            else if (part !== ".")
                result.push(part);
        }
        return result.join("/");
    }

    class URL {
        constructor(url, base) {
            const href = resolveURL(url, base);
            this.href = href;
            const match = href.match(/^([a-z][a-z0-9+.-]*:)(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/i);
            if (match) {
                this.protocol = match[1];
                this.host = (match[2] || "").replace(/^\/\//, "");
                this.hostname = this.host.split(":")[0];
                this.port = this.host.split(":")[1] || "";
                this.pathname = match[3] || "";
                this.search = match[4] || "";
                this.hash = match[5] || "";
                this.origin = this.host ? this.protocol + "//" + this.host : this.protocol;
            } else {
                const hashIndex = href.indexOf("#");
                const queryIndex = href.indexOf("?");
                this.hash = hashIndex === -1 ? "" : href.slice(hashIndex);
                this.search = queryIndex === -1 ? "" : href.slice(queryIndex, hashIndex === -1 ? undefined : hashIndex);
                this.pathname = href.slice(0, queryIndex === -1 ? (hashIndex === -1 ? undefined : hashIndex) : queryIndex);
                this.protocol = "";
                this.host = this.hostname = this.port = this.origin = "";
            }
            this.searchParams = new URLSearchParams(this.search);
        }
        toString() { return this.href; }
        toJSON() { return this.href; }
    }
    g.URL = URL;

    const locationState = { protocol: "file:", host: "", hostname: "", port: "", pathname: "/dist/index.html", search: "", hash: "" };
    g.location = {
        get protocol() { return locationState.protocol; },
        get host() { return locationState.host; },
        get hostname() { return locationState.hostname; },
        get port() { return locationState.port; },
        get pathname() { return locationState.pathname; },
        set pathname(value) { locationState.pathname = value; },
        get search() { return locationState.search; },
        get hash() { return locationState.hash; },
        get href() { return `file://${locationState.pathname}${locationState.search}${locationState.hash}`; },
        get origin() { return "file://"; },
        toString() { return this.href; },
        assign(url) { locationState.pathname = String(url); },
        replace(url) { locationState.pathname = String(url); },
        reload() {},
    };

    const historyEntries = [{ state: null, url: "/" }];
    let historyIndex = 0;
    function updateLocationFromHistory() {
        const entry = historyEntries[historyIndex];
        const url = entry && entry.url ? String(entry.url) : "/";
        locationState.pathname = url.startsWith("/") ? "/dist" + url : url;
    }
    g.history = {
        get state() { return historyEntries[historyIndex].state; },
        get length() { return historyEntries.length; },
        scrollRestoration: "auto",
        pushState(state, title, url) {
            historyEntries.splice(historyIndex + 1);
            historyEntries.push({ state, url: url || locationState.pathname });
            historyIndex++;
            updateLocationFromHistory();
        },
        replaceState(state, title, url) {
            historyEntries[historyIndex] = { state, url: url || locationState.pathname };
            updateLocationFromHistory();
        },
        back() {
            if (historyIndex > 0) {
                historyIndex--;
                updateLocationFromHistory();
                g.setTimeout(() => g.dispatchEvent(new Event("popstate")), 0);
            }
        },
        forward() {
            if (historyIndex + 1 < historyEntries.length) {
                historyIndex++;
                updateLocationFromHistory();
                g.setTimeout(() => g.dispatchEvent(new Event("popstate")), 0);
            }
        },
        go(delta) {
            if (delta < 0)
                this.back();
            else if (delta > 0)
                this.forward();
        },
    };

    function resolveFetchPath(input) {
        let path = input && input.href !== undefined ? input.href : String(input);
        if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
            if (path.startsWith("file://")) {
                path = path.slice(7);
            } else {
                try { path = new URL(path).pathname; } catch (e) {}
            }
        }
        path = path.replace(/^\/+/, "");
        const marker = "/socialfeed-react/";
        const index = path.indexOf(marker);
        if (index !== -1)
            path = path.slice(index + marker.length);
        if (path.startsWith("dist/"))
            return path;
        if (/^[^/]+\.(json|jsonl|txt)$/.test(path))
            return "dist/data/" + path;
        return "dist/" + path.replace(/^\.?\//, "");
    }

    g.fetch = function (input) {
        let path;
        try {
            path = resolveFetchPath(input);
            const text = readFile(path);
            return Promise.resolve({
                ok: true,
                status: 200,
                statusText: "OK",
                url: String(input && input.href !== undefined ? input.href : input),
                text: () => Promise.resolve(String(text)),
                json: () => Promise.resolve(JSON.parse(text)),
                arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
            });
        } catch (error) {
            return Promise.reject(new Error(`Failed to fetch ${input}: ${error}`));
        }
    };

    g.navigator = {
        platform: "shell",
        userAgent: "shell",
        language: "en-US",
        languages: ["en-US"],
        onLine: true,
        clipboard: { writeText() { return Promise.resolve(); }, readText() { return Promise.resolve(""); } },
    };
    g.localStorage = {
        _values: Object.create(null),
        getItem(name) { return Object.prototype.hasOwnProperty.call(this._values, name) ? this._values[name] : null; },
        setItem(name, value) { this._values[name] = String(value); },
        removeItem(name) { delete this._values[name]; },
        clear() { this._values = Object.create(null); },
    };
    g.sessionStorage = g.localStorage;
    g.matchMedia = (query) => ({ matches: false, media: String(query), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    g.getComputedStyle = (element) => styleProxy(element);
    g.devicePixelRatio = 1;
    g.innerWidth = 1440;
    g.innerHeight = 815;
    g.outerWidth = 1440;
    g.outerHeight = 815;
    g.scrollX = 0;
    g.scrollY = 0;
    g.pageXOffset = 0;
    g.pageYOffset = 0;
    g.scrollTo = (x, y) => {
        if (typeof x === "object") {
            g.scrollX = Number(x.left) || 0;
            g.scrollY = Number(x.top) || 0;
        } else {
            g.scrollX = Number(x) || 0;
            g.scrollY = Number(y) || 0;
        }
        g.pageXOffset = g.scrollX;
        g.pageYOffset = g.scrollY;
        notifyScroll(g.document);
    };
    g.scrollBy = (x, y) => {
        if (typeof x === "object")
            g.scrollTo(g.scrollX + (Number(x.left) || 0), g.scrollY + (Number(x.top) || 0));
        else
            g.scrollTo(g.scrollX + (Number(x) || 0), g.scrollY + (Number(y) || 0));
    };
    g.event_listeners = Object.create(null);
    g._react_callback = null;
    g.addEventListener = eventTargetPrototype.addEventListener.bind(g);
    g.removeEventListener = eventTargetPrototype.removeEventListener.bind(g);
    g.dispatchEvent = eventTargetPrototype.dispatchEvent.bind(g);

    // ------------------------------------------------------------------
    // Selection and editing

    class Range {
        constructor() {
            this.startContainer = null;
            this.startOffset = 0;
            this.endContainer = null;
            this.endOffset = 0;
            this.collapsed = true;
        }
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; this.collapsed = this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; this.collapsed = this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
        collapse() { this.endContainer = this.startContainer; this.endOffset = this.startOffset; this.collapsed = true; }
        selectNodeContents(node) { this.startContainer = this.endContainer = node; this.startOffset = 0; this.endOffset = node.textContent.length; this.collapsed = false; }
        selectNode(node) {
            const parent = node.parentNode;
            if (!parent)
                return;
            const index = parent.childNodes.indexOf(node);
            this.startContainer = this.endContainer = parent;
            this.startOffset = index;
            this.endOffset = index + 1;
            this.collapsed = false;
        }
        cloneRange() {
            const range = new Range();
            range.startContainer = this.startContainer;
            range.startOffset = this.startOffset;
            range.endContainer = this.endContainer;
            range.endOffset = this.endOffset;
            range.collapsed = this.collapsed;
            return range;
        }
        detach() {}
        setStartAfter(node) { this.startContainer = node.parentNode; this.startOffset = node.parentNode.childNodes.indexOf(node) + 1; }
        setEndBefore(node) { this.endContainer = node.parentNode; this.endOffset = node.parentNode.childNodes.indexOf(node); }
        setEndAfter(node) { this.endContainer = node.parentNode; this.endOffset = node.parentNode.childNodes.indexOf(node) + 1; }
        setStartBefore(node) { this.startContainer = node.parentNode; this.startOffset = node.parentNode.childNodes.indexOf(node); }
        insertNode(node) {
            if (this.startContainer && this.startContainer.nodeType === 1)
                this.startContainer.appendChild(node);
        }
        cloneContents() {
            const fragment = g.document.createDocumentFragment();
            if (this.startContainer) {
                if (this.startContainer.nodeType === 1) {
                    for (const child of this.startContainer.childNodes)
                        fragment.appendChild(child.cloneNode(true));
                } else if (this.startContainer.parentNode) {
                    fragment.appendChild(this.startContainer.parentNode.cloneNode(true));
                }
            }
            return fragment;
        }
        getBoundingClientRect() { return { top: 0, left: 0, bottom: 16, right: 100, width: 100, height: 16 }; }
        getClientRects() { return [this.getBoundingClientRect()]; }
        toString() { return this.startContainer ? this.startContainer.textContent : ""; }
    }

    class Selection {
        constructor() {
            this.anchorNode = null;
            this.anchorOffset = 0;
            this.focusNode = null;
            this.focusOffset = 0;
            this.rangeCount = 0;
            this._ranges = [];
        }
        removeAllRanges() { this._ranges = []; this.rangeCount = 0; this.anchorNode = this.focusNode = null; }
        addRange(range) { this._ranges.push(range); this.rangeCount = this._ranges.length; this.anchorNode = range.startContainer; this.focusNode = range.endContainer; }
        getRangeAt(index) { return this._ranges[index] || new Range(); }
        collapse(node, offset) {
            const range = new Range();
            range.setStart(node, offset);
            range.collapse();
            this.removeAllRanges();
            this.addRange(range);
        }
        selectAllChildren(node) {
            const range = new Range();
            range.selectNodeContents(node);
            this.removeAllRanges();
            this.addRange(range);
        }
        extend(node, offset) {
            const range = this.getRangeAt(0);
            range.setEnd(node, offset);
            this.focusNode = node;
            this.focusOffset = offset;
        }
        get isCollapsed() { return this.rangeCount === 0 || this.getRangeAt(0).collapsed; }
        toString() { return this.rangeCount ? this.getRangeAt(0).toString() : ""; }
    }

    g.Range = Range;
    g.Selection = Selection;
    g.SelectionConstructor = Selection;

    function activeEditable() {
        const active = g.document.activeElement;
        if (!active)
            return null;
        if (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
            return active;
        if (active.isContentEditable)
            return active;
        return null;
    }

    function insertionContainer(element) {
        let node = element.lastChild;
        while (node && node.nodeType === 1 && node.tagName !== "BR")
            node = node.lastChild;
        if (node && node.tagName === "BR")
            return node.parentNode;
        if (node && node.nodeType === 3)
            return node;
        return element;
    }

    function setSelectionToNode(node, offset) {
        const range = new Range();
        range.setStart(node, offset);
        range.setEnd(node, offset);
        range.collapsed = true;
        g.document._selection.removeAllRanges();
        g.document._selection.addRange(range);
        g.document.dispatchEvent(new Event("selectionchange"));
    }

    function setSelectionAtEnd(element) {
        const container = insertionContainer(element);
        if (container.nodeType === 3) {
            setSelectionToNode(container, container.data.length);
            return;
        }
        let node = container.lastChild;
        while (node && node.nodeType === 1 && node.tagName !== "BR")
            node = node.lastChild;
        if (node && node.nodeType === 3) {
            setSelectionToNode(node, node.data.length);
            return;
        }
        const textNode = g.document.createTextNode("");
        const br = container.lastChild && container.lastChild.tagName === "BR" ? container.lastChild : null;
        if (br)
            container.insertBefore(textNode, br);
        else
            container.appendChild(textNode);
        setSelectionToNode(textNode, 0);
    }

    function insertTextNodeAtEnd(element, text) {
        const container = insertionContainer(element);
        if (container.nodeType === 3) {
            container.data += text;
            return;
        }
        const textNode = g.document.createTextNode(text);
        if (container.lastChild && container.lastChild.tagName === "BR")
            container.insertBefore(textNode, container.lastChild);
        else
            container.appendChild(textNode);
    }

    function setInputValue(element, value) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        if (descriptor && descriptor.set)
            descriptor.set.call(element, value);
        else
            element.value = value;
    }

    function insertTextInto(element, text) {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            const start = element.selectionStart ?? element.value.length;
            const end = element.selectionEnd ?? element.value.length;
            const value = element.value;
            setInputValue(element, value.slice(0, start) + text + value.slice(end));
            element.selectionStart = element.selectionEnd = start + text.length;
            element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }
        if (element.isContentEditable) {
            const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: text, inputType: "insertText" });
            const allowed = element.dispatchEvent(before);
            if (allowed) {
                // React can synthesize onBeforeInput from textInput, for paths
                // that don't read the native event directly.
                const textInput = new InputEvent("textInput", { bubbles: true, cancelable: true, data: text });
                if (element.dispatchEvent(textInput))
                    insertTextNodeAtEnd(element, text);
            }
            element.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true }));
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Document

    class Attr extends Node {
        constructor(name, value) {
            super(2, String(name));
            this.name = String(name);
            this.value = String(value ?? "");
            this.ownerElement = null;
        }
    }
    class CSSStyleDeclaration {
        constructor() { return styleProxy({ _style: Object.create(null) }); }
    }
    class DOMTokenList {}
    class NamedNodeMap extends Array {}
    class DOMRect {}
    class DOMRectReadOnly {}
    class Window extends EventTarget {}
    class History {}
    g.Attr = Attr;
    g.CSSStyleDeclaration = CSSStyleDeclaration;
    g.DOMTokenList = DOMTokenList;
    g.NamedNodeMap = NamedNodeMap;
    g.DOMRect = DOMRect;
    g.DOMRectReadOnly = DOMRectReadOnly;
    g.Window = Window;
    g.History = History;

    // Hyperion requires window's prototype chain to include the
    // EventTarget prototype. The global object's prototype cannot be changed,
    // so expose a window object with the expected chain over the global.
    let shellWindow = null;
    shellWindow = new Proxy(g, {
        getPrototypeOf() { return Window.prototype; },
        get(target, property, receiver) {
            if (property === "window" || property === "self")
                return shellWindow;
            return Reflect.get(target, property, receiver);
        },
        set(target, property, value) {
            return Reflect.set(target, property, value, target);
        },
    });
    g.window = shellWindow;
    g.self = shellWindow;

    class Document extends Node {
        constructor() {
            super(9, "#document");
            this.documentElement = new HTMLHtmlElement("html");
            this.head = new HTMLHeadElement("head");
            this.body = new HTMLBodyElement("body");
            this.appendChild(this.documentElement);
            this.documentElement.appendChild(this.head);
            this.documentElement.appendChild(this.body);
            this.readyState = "complete";
            this.compatMode = "CSS1Compat";
            this.cookie = "";
            this.baseURI = "dist/";
            this.activeElement = this.body;
            this.defaultView = g;
            this.currentScript = null;
            this.documentMode = undefined;
            this.hidden = false;
            this.visibilityState = "visible";
            this.implementation = {
                createHTMLDocument: () => this,
                hasFeature: () => true,
            };
            this._selection = new Selection();
            this._styleSheets = [];
        }
        createElement(tagName) {
            const Constructor = getElementConstructor(tagName);
            return new Constructor(tagName);
        }
        createElementNS(namespace, tagName) { return this.createElement(tagName); }
        createTextNode(data) { return new Text(String(data)); }
        createComment(data) { return new Comment(String(data)); }
        createDocumentFragment() { return new DocumentFragment(); }
        createEvent(type) { return new Event(type); }
        createRange() { return new Range(); }
        createTreeWalker(root, whatToShow, filter) { return new TreeWalker(root, whatToShow, filter); }
        getSelection() { return this._selection; }
        getElementById(id) {
            id = String(id);
            return allElements().find((element) => element.getAttribute("id") === id) || null;
        }
        getElementsByClassName(name) {
            return allElements().filter((element) => getClasses(element).includes(name));
        }
        getElementsByTagName(name) {
            name = String(name).toLowerCase();
            return allElements().filter((element) => name === "*" || element.tagName.toLowerCase() === name);
        }
        getElementsByName(name) {
            return allElements().filter((element) => element.getAttribute("name") === name);
        }
        querySelector(selector) { return querySelector(this.documentElement, selector); }
        querySelectorAll(selector) { return querySelectorAll(this.documentElement, selector); }
        elementFromPoint(x, y) {
            return allElements().find((element) => {
                const rect = getBoundingClientRect(element);
                return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
            }) || this.body;
        }
        elementsFromPoint(x, y) { return [this.elementFromPoint(x, y)]; }
        execCommand(command, showUI, value) {
            command = String(command);
            const editable = activeEditable() || this.body;
            if (command === "insertText") {
                return insertTextInto(editable, String(value ?? ""));
            }
            if (command === "selectAll") {
                if (editable.tagName === "INPUT" || editable.tagName === "TEXTAREA")
                    editable.select();
                else
                    this._selection.selectAllChildren(editable);
                return true;
            }
            if (command === "delete" || command === "forwardDelete") {
                if (editable.tagName === "INPUT" || editable.tagName === "TEXTAREA") {
                    const start = editable.selectionStart ?? 0;
                    const end = editable.selectionEnd ?? editable.value.length;
                    setInputValue(editable, editable.value.slice(0, start) + editable.value.slice(end));
                    editable.selectionStart = editable.selectionEnd = start;
                } else {
                    while (editable.firstChild)
                        editable.removeChild(editable.firstChild);
                }
                editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: command === "delete" ? "deleteContentBackward" : "deleteContentForward" }));
                return true;
            }
            if (command === "copy" || command === "cut" || command === "paste")
                return true;
            return false;
        }
        hasFocus() { return true; }
        get elementFromPointForDebug() { return this.elementFromPoint; }
    }
    class HTMLDocument extends Document {}
    g.Document = Document;
    g.HTMLDocument = HTMLDocument;
    g.document = new HTMLDocument();
    g.document.location = g.location;
    g.document.defaultView = g.window;
    g.getSelection = () => g.document.getSelection();
    for (const name of Object.getOwnPropertyNames(Node)) {
        if (/_NODE$/.test(name) || /^DOCUMENT_POSITION/.test(name))
            g.document[name] = Node[name];
    }

    // HTMLCollection and friends are simple arrays in this shim, which is
    // enough for all consumers in the workload.
    g.HTMLCollection = Array;
    g.NodeList = Array;

    // A couple of globals used by React's synthetic event system.
    g.document.documentElement.clientWidth = 1440;
    g.document.documentElement.clientHeight = 815;
    g.onhashchange = null;
    g.onpopstate = null;

    // Make property-style event handlers work on the window as well.
    for (const type of ["click", "keydown", "keyup", "keypress", "input", "change", "pointerdown", "pointerover", "pointerout", "pointermove", "mousemove", "mousedown", "mouseup", "scroll", "resize", "popstate", "focus", "blur"])
        g["on" + type] = null;
})();
