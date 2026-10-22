// Browser-test access through CDP only. Closed roots stay inaccessible to the
// webpage; the root map exists solely in Playwright's isolated utility world.
// Inspect collections with element.evaluate(): Playwright runs evaluateAll()
// selector queries in the page world, which intentionally cannot read this map.
import { selectors } from 'playwright';

await selectors.register('cd', () => ({
  query(root, selector) { return this.queryAll(root, selector)[0] || null; },
  queryAll(root, selector) {
    return [...(globalThis.__captionDropTestRoots?.get(root) || root).querySelectorAll(selector)];
  },
}), { contentScript: true });

const sessions = new WeakMap();
async function exposeForAutomation(target) {
  // Ensure Playwright has created its utility world in this document.
  await target.locator('body').count();
  let state = sessions.get(target);
  if (!state) {
    const session = await (target.context ? target.context() : target.page().context()).newCDPSession(target);
    state = { session, contexts: new Map() };
    session.on('Runtime.executionContextCreated', ({ context }) => state.contexts.set(context.id, context));
    session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => state.contexts.delete(executionContextId));
    session.on('Runtime.executionContextsCleared', () => state.contexts.clear());
    sessions.set(target, state);
    await session.send('Runtime.enable');
  }
  const { session, contexts } = state;
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const roots = [];
  const visit = node => {
    if (node.shadowRootType === 'closed') roots.push(node);
    for (const child of [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : [])]) visit(child);
  };
  visit(root);
  const worlds = [...contexts.values()].filter(context => context.name.startsWith('__playwright_utility_world'));
  for (const shadow of roots) {
    for (const world of worlds) {
      let objectId;
      try {
        ({ object: { objectId } } = await session.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId, executionContextId: world.id }));
        await session.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function() { if (this.host?.ownerDocument !== document) return; globalThis.__captionDropTestRoots ||= new WeakMap(); globalThis.__captionDropTestRoots.set(this.host, this); }',
        });
      } finally {
        if (objectId) await session.send('Runtime.releaseObject', { objectId }).catch(() => {});
      }
    }
  }
}

export function closedShadow(target, selector) {
  const wrap = locator => new Proxy(locator, {
    get(object, property) {
      if (property === 'locator') return (selector, options) => wrap(object.locator(`cd=${selector}`, options));
      if (['first', 'last', 'nth', 'filter'].includes(property)) return (...args) => wrap(object[property](...args));
      const member = object[property];
      if (typeof member !== 'function') return member;
      return async (...args) => {
        await exposeForAutomation(target);
        return member.apply(object, args);
      };
    },
  });
  return wrap(target.locator(selector));
}
