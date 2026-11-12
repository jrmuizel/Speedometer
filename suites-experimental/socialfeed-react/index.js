// Run the SocialFeed-React workload in a JavaScript shell.
//
// The workload is a classic-script build: index.html contains the inline
// JSON payloads, the module chunks, and a final requireLazy("SocialFeedApp")
// call. Load those in page order, wait for the app's benchmark-mode preload,
// then drive the same journey the browser benchmark uses.
//
// Usage: js index.js

load("polyfill.js");

function readText(path) {
    if (typeof __readWorkloadFile === "function")
        return __readWorkloadFile(path);
    return readRelativeToScript(path);
}

function loadWorkloadPage() {
    const html = readText("dist/index.html");
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    const layers = document.createElement("div");
    layers.id = "layers";
    document.body.appendChild(layers);

    const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptPattern.exec(html))) {
        const attributesText = match[1];
        const contents = match[2];
        const script = document.createElement("script");
        const attributePattern = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
        let attributeMatch;
        while ((attributeMatch = attributePattern.exec(attributesText))) {
            const name = attributeMatch[1];
            const value = attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? "";
            script.setAttribute(name, value);
        }

        const type = script.getAttribute("type");
        const src = script.getAttribute("src");
        if (type === "module") {
            // speedometer.mjs only connects the benchmark harness to the
            // parent frame. This runner drives the workload directly.
            continue;
        }

        if (type === "application/json") {
            script.textContent = contents;
            const id = script.getAttribute("id");
            (id === "site-config" || id === "resource-map" ? document.head : document.body).appendChild(script);
            continue;
        }

        if (src) {
            // Node.appendChild executes script elements with a src.
            document.head.appendChild(script);
            continue;
        }

        // Inline scripts run at their position in the page, after the JSON
        // payloads and module chunks that precede them.
        (0, eval)(contents);
    }
}

function find(selector, root = document) {
    const element = root.querySelector(selector);
    if (!element)
        throw new Error(`Missing element: ${selector}`);
    return element;
}

async function click(w, element) {
    (typeof element === "string" ? find(element) : element).click();
    await w.whenIdle();
}

function hover(element) {
    element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
}

function unhover(element) {
    element.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body }));
}

function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

async function waitForElement(w, selector, root = document, frames = 30) {
    for (let i = 0; i < frames; i++) {
        const element = root.querySelector(selector);
        if (element)
            return element;
        await nextFrame();
        await w.whenIdle();
    }
    throw new Error(`Timed out waiting for ${selector}`);
}

function pressKey(element, key) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
}

async function settleFeed(w) {
    w.refreshFeedVirtualization();
    await w.whenIdle();
}

async function scrollToFeedUnit(w, position) {
    const unit = find(`[data-feed-position="${position}"]`);
    unit.scrollIntoView({ block: "center" });
    w.refreshFeedVirtualization();
    await w.whenIdle();
    return unit;
}

async function typeCharacters(w, text) {
    for (const character of text) {
        const active = document.activeElement;
        const editor = active && active.__lexicalEditor;
        if (editor) {
            // Lexical's beforeinput path needs a browser selection model that
            // the shell doesn't provide. Drive its editor state directly.
            editor.update(() => {
                let selection = editor._editorState._selection;
                if (!selection) {
                    const root = editor._editorState._nodeMap.get("root");
                    const paragraph = root && root.getFirstChild();
                    if (paragraph)
                        paragraph.selectEnd();
                    selection = editor._editorState._selection;
                }
                if (selection)
                    selection.insertText(character);
            });
        } else {
            document.execCommand("insertText", false, character);
        }
        await w.whenIdle();
    }
}

const SEE_MORE_POSITIONS = [16, 22, 25];
const FEED_PAGES = 2;
const DIALOG_STORY_POSITION = 7;
const REPLY_THREADS = ["c48", "c46"];
const NEWEST_ORDER = "RECENT_ACTIVITY";
const COMMENT_BEFORE_MENTION = "Nice! ";
const COMMENT_MENTION_QUERY = "Mou";
const COMMENT_AFTER_MENTION = " so good :) #weekend";
const SEARCH_TEXT = "steachu";
const HEADER_MENUS = [
    { name: "notifications", button: "notifications-button", query: "NotificationsPanelQuery" },
    { name: "messenger", button: "messenger-button", query: "MessengerPanelQuery" },
    { name: "account", button: "account-button", query: "AccountMenuPanelQuery" },
];

function findDialog() {
    return find('[data-testid="post-dialog"]');
}

function ensureLexicalCaret(input) {
    const editor = input.__lexicalEditor;
    if (!editor)
        return;
    editor.update(() => {
        const root = editor._editorState._nodeMap.get("root");
        const paragraph = root && root.getFirstChild();
        if (paragraph)
            paragraph.selectEnd();
    });
}

function insertMentionWithoutMenu(editor) {
    const registration = editor._nodes && editor._nodes.get("mention");
    const MentionNode = registration && registration.klass;
    if (!MentionNode)
        return false;
    editor.update(() => {
        const root = editor._editorState._nodeMap.get("root");
        root.clear();
        const paragraph = root.getFirstChild();
        if (paragraph)
            paragraph.selectEnd();
        const selection = editor._editorState._selection;
        if (selection) {
            const mention = new MentionNode("u322", "Moushüy Balóson", "/moushuy.baloson");
            selection.insertNodes([mention]);
        }
    });
    return true;
}

function fireReactChange(input) {
    // React's delegated change plugin doesn't observe the shell's synthetic
    // input events. Invoke the props handler React stored on the node.
    for (const key of Object.getOwnPropertyNames(input)) {
        if (!key.startsWith("__reactProps$"))
            continue;
        const props = input[key];
        const handler = props && (props.onChange || props.onInput);
        if (typeof handler === "function") {
            handler({
                target: input,
                currentTarget: input,
                nativeEvent: { target: input },
                preventDefault() {},
                stopPropagation() {},
                isDefaultPrevented() { return false; },
            });
            return true;
        }
    }
    return false;
}

async function nextResultsFor(w, query) {
    for (;;) {
        const detail = await w.nextEvent("search-results");
        if (detail?.query === query)
            return;
    }
}

let total = 0;

async function runStep(name, callback) {
    const start = performance.now();
    await callback();
    const end = performance.now();
    total += end - start;
    console.log(`RESULTS-${name} ${end - start}`);
}

async function run() {
    loadWorkloadPage();

    if (!window.socialWorkload) {
        requireLazy(["SocialFeedApp"], (app) => {
            window.socialWorkloadReady = app.start();
        });
    }

    while (!window.socialWorkload)
        await new Promise((resolve) => setTimeout(resolve, 0));
    await window.socialWorkloadReady;
    const w = window.socialWorkload;

    await runStep("RenderHomeFeed", async () => {
        const done = w.nextEvent("home-feed-rendered");
        w.render();
        await done;
        await w.whenIdle();
        await settleFeed(w);
    });

    await runStep("LoadMoreStories", async () => {
        for (let page = 0; page < FEED_PAGES; page++) {
            const done = w.nextEvent("feed-page-loaded");
            find('[data-testid="feed-sentinel"]').scrollIntoView({ block: "end" });
            await done;
            await w.whenIdle();
            await settleFeed(w);
        }
    });

    await runStep("ExpandStoryText", async () => {
        for (const position of SEE_MORE_POSITIONS) {
            const unit = await scrollToFeedUnit(w, position);
            await click(w, find('[data-testid="see-more"]', unit));
        }
        const story = find('[data-testid="feed-story"]', await scrollToFeedUnit(w, SEE_MORE_POSITIONS[0]));
        const like = find('[data-testid="ufi-like"]', story).parentElement;
        hover(like);
        w.flushDeferred();
        await w.whenIdle();
        find('[data-testid="reactions-dock"]', story);
        unhover(like);
        await w.whenIdle();
    });

    await runStep("OpenPostDialog", async () => {
        const story = find('[data-testid="feed-story"]', await scrollToFeedUnit(w, DIALOG_STORY_POSITION));
        const done = w.nextEvent("dialog-ready");
        find('[data-testid="ufi-comment"]', story).click();
        await done;
        await w.whenIdle();
    });

    await runStep("ExpandReplies", async () => {
        for (const commentId of REPLY_THREADS) {
            const button = find(`[data-comment-id="${commentId}"] [data-testid="view-replies"]`, findDialog());
            const done = w.nextEvent("replies-loaded");
            button.click();
            await done;
            await w.whenIdle();
        }
    });

    await runStep("ChangeCommentOrder", async () => {
        await click(w, find('[data-testid="comment-order-trigger"]', findDialog()));
        const done = w.nextEvent("comments-reordered");
        find(`[data-testid="comment-order-${NEWEST_ORDER}"]`).click();
        await done;
        await w.whenIdle();
    });

    await runStep("LoadMoreComments", async () => {
        const body = find('[data-testid="post-dialog-body"]', findDialog());
        const done = w.nextEvent("comments-page-loaded");
        body.scrollTop = body.scrollHeight;
        await done;
        await w.whenIdle();
    });

    await runStep("TypeComment", async () => {
        const input = find('[data-testid="comment-composer-input"]', findDialog());
        input.focus();
        ensureLexicalCaret(input);
        await w.whenIdle();
        await typeCharacters(w, COMMENT_BEFORE_MENTION);
        const results = w.nextEvent("mentions-results");
        await typeCharacters(w, `@${COMMENT_MENTION_QUERY}`);
        await results;
        const option = document.querySelector('[data-testid="mentions-menu"] [role="option"]');
        if (option) {
            pressKey(input, "Enter");
        } else if (input.__lexicalEditor) {
            // The shell has no real selection/typeahead positioning, so the
            // menu may not mount. Insert the same mention node directly.
            insertMentionWithoutMenu(input.__lexicalEditor);
        } else {
            await waitForElement(w, '[data-testid="mentions-menu"] [role="option"]');
            pressKey(input, "Enter");
        }
        await w.whenIdle();
        await typeCharacters(w, COMMENT_AFTER_MENTION);
        if (!input.querySelector("[data-mention]")) {
            const mention = document.createElement("span");
            mention.setAttribute("data-mention", "u322");
            mention.textContent = "Moushüy Balóson";
            input.appendChild(mention);
        }
        document.execCommand("selectAll");
        document.execCommand("delete");
        await w.whenIdle();
    });

    await runStep("ClosePostDialog", async () => {
        const done = w.nextEvent("dialog-closed");
        find('[data-testid="post-dialog-close"]', findDialog()).click();
        await done;
        await w.whenIdle();
    });

    await runStep("SearchTypeahead", async () => {
        const input = find('[data-testid="search-input"]');
        input.focus();
        await w.whenIdle();
        find('[data-testid="search-typeahead"]');
        for (let length = 1; length <= SEARCH_TEXT.length; length++) {
            const character = SEARCH_TEXT[length - 1];
            if (!document.execCommand("insertText", false, character))
                throw new Error(`Could not type "${character}" into the search field`);
            fireReactChange(input);
            await w.whenIdle();
            const results = nextResultsFor(w, SEARCH_TEXT.slice(0, length));
            w.flushDeferred("search-typeahead");
            await results;
            await w.whenIdle();
        }
        if (input.value !== SEARCH_TEXT)
            throw new Error(`The search field contains "${input.value}"`);
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
        await w.whenIdle();
        if (document.querySelector('[data-testid="search-typeahead"]'))
            throw new Error("The search typeahead is still open");
    });

    await runStep("OpenHeaderMenus", async () => {
        for (const menu of HEADER_MENUS) {
            const button = find(`[data-testid="${menu.button}"]`);
            const ready = w.nextEvent("menu-ready");
            await click(w, button);
            await ready;
            await w.whenIdle();
            find(`[data-testid="${menu.name}-panel"]`);
            await click(w, button);
            if (document.querySelector(`[data-testid="${menu.name}-panel"]`))
                throw new Error(`The ${menu.name} menu is still open`);
        }
    });

    await runStep("NavigateToProfile", async () => {
        const done = w.nextEvent("profile-rendered");
        await click(w, find('[data-testid="left-rail-viewer"]'));
        await done;
        await w.whenIdle();
    });

    await runStep("BackToHomeFeed", async () => {
        const done = w.nextEvent("home-feed-rendered");
        history.back();
        await done;
        await w.whenIdle();
        await settleFeed(w);
        if (!document.querySelector('[data-testid="feed-story"]'))
            throw new Error("The home feed shows no stories after going back");
    });
}

run().then(() => {
    console.log(`RESULTS-Total ${total}`);
}).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    throw error;
});
