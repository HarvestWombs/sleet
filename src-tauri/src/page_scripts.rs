//! Scripts Sleet runs in pages. They work in every engine (WebView2, WebKit),
//! and talk back through `sleet-command://` navigations, which Sleet cancels
//! before anything loads (see `on_navigation` in lib.rs).

/// Ctrl/Cmd-click and middle-click open links in a background tab,
/// Shift-click in a foreground tab; full-screen changes are reported so Sleet
/// can hide its own interface. Top frame only.
pub const LINK_SCRIPT: &str = r#"
(() => {
  if (window.top !== window || window.__sleetLinks) return;
  window.__sleetLinks = true;
  const send = (command) => { window.location.href = `sleet-command://${command}`; };
  const linkOf = (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.hasAttribute('download')) return null;
    return /^https?:/i.test(anchor.href) ? anchor.href : null;
  };
  const open = (event, background) => {
    const url = linkOf(event);
    if (!url) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send(`${background ? 'background-tab' : 'foreground-tab'}?u=${encodeURIComponent(url)}`);
  };
  document.addEventListener('click', (event) => {
    if (event.button === 0 && (event.ctrlKey || event.metaKey)) open(event, !event.shiftKey);
    else if (event.button === 0 && event.shiftKey) open(event, false);
  }, true);
  document.addEventListener('auxclick', (event) => { if (event.button === 1) open(event, true); }, true);
  // No autoscroll cursor when middle-clicking a link.
  document.addEventListener('mousedown', (event) => { if (event.button === 1 && linkOf(event)) event.preventDefault(); }, true);
  document.addEventListener('fullscreenchange', () => send(document.fullscreenElement ? 'fullscreen-enter' : 'fullscreen-exit'));
})();
"#;

/// Find in page using the CSS Custom Highlight API: matches are highlighted
/// without changing the page's DOM. Returns `{"count":n,"index":i}`.
pub fn find_script(query: &str, backwards: bool, restart: bool) -> String {
    let query = serde_json::to_string(query).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(() => {{
  const query = {query};
  const backwards = {backwards};
  const restart = {restart};
  const state = window.__sleetFindState || (window.__sleetFindState = {{ query: '', ranges: [], index: -1 }});
  const highlights = typeof Highlight !== 'undefined' && window.CSS && CSS.highlights;
  if (!document.getElementById('__sleet_find_style')) {{
    const style = document.createElement('style');
    style.id = '__sleet_find_style';
    style.textContent = '::highlight(sleet-find){{background-color:rgba(255,213,79,.55);color:inherit}}::highlight(sleet-find-current){{background-color:#ff9632;color:#111}}';
    (document.head || document.documentElement).appendChild(style);
  }}
  if (restart || query !== state.query) {{
    state.query = query;
    state.ranges = [];
    state.index = -1;
    const needle = query.toLowerCase();
    if (needle) {{
      const root = document.body || document.documentElement;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {{
        acceptNode(node) {{
          const parent = node.parentElement;
          if (!parent || parent.closest('script,style,noscript,template,textarea,select,head')) return NodeFilter.FILTER_REJECT;
          return node.nodeValue && node.nodeValue.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }},
      }});
      for (let node = walker.nextNode(); node && state.ranges.length < 5000; node = walker.nextNode()) {{
        const text = node.nodeValue.toLowerCase();
        for (let at = text.indexOf(needle); at !== -1 && state.ranges.length < 5000; at = text.indexOf(needle, at + needle.length)) {{
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          if (range.getClientRects().length > 0) state.ranges.push(range);
        }}
      }}
    }}
  }}
  const count = state.ranges.length;
  if (count === 0) state.index = -1;
  else if (state.index === -1) state.index = backwards ? count - 1 : 0;
  else if (!restart) state.index = (state.index + (backwards ? -1 : 1) + count) % count;
  if (highlights) {{
    if (count) CSS.highlights.set('sleet-find', new Highlight(...state.ranges)); else CSS.highlights.delete('sleet-find');
    if (state.index >= 0) CSS.highlights.set('sleet-find-current', new Highlight(state.ranges[state.index])); else CSS.highlights.delete('sleet-find-current');
  }}
  const current = state.ranges[state.index];
  if (current) {{
    const box = current.getBoundingClientRect();
    if (box.top < 70 || box.bottom > window.innerHeight - 40 || box.left < 0 || box.right > window.innerWidth) {{
      const element = current.startContainer.parentElement;
      if (element) element.scrollIntoView({{ block: 'center', inline: 'nearest' }});
    }}
  }}
  return JSON.stringify({{ count, index: state.index }});
}})()"#
    )
}

/// Removes find highlights and state.
pub const FIND_CLEAR_SCRIPT: &str = r#"(() => {
  if (window.CSS && CSS.highlights) { CSS.highlights.delete('sleet-find'); CSS.highlights.delete('sleet-find-current'); }
  window.__sleetFindState = undefined;
  return '{}';
})()"#;
