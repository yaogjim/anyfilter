import { FEED_SITES, type FeedSite } from '../domain/feed-sites';

/** What registering a site's script needs from the browser. Injected so the
 * decisions can be tested without one. */
export interface SiteScriptDeps {
  hasPermission(pattern: string): Promise<boolean>;
  isRegistered(scriptId: string): Promise<boolean>;
  register(site: FeedSite): Promise<void>;
  unregister(scriptId: string): Promise<void>;
  /** Puts the script into the tabs of that site that are already open. */
  injectIntoOpenTabs(site: FeedSite): Promise<void>;
}

export function chromeSiteScriptDeps(): SiteScriptDeps {
  return {
    async hasPermission(pattern) {
      try {
        return await chrome.permissions.contains({ origins: [pattern] });
      } catch {
        return false;
      }
    },
    async isRegistered(scriptId) {
      const found = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] });
      return found.length > 0;
    },
    async register(site) {
      await chrome.scripting.registerContentScripts([
        {
          id: site.scriptId,
          js: [site.file],
          matches: [site.pattern],
          runAt: 'document_idle',
          persistAcrossSessions: true,
        },
      ]);
    },
    async unregister(scriptId) {
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
    },
    async injectIntoOpenTabs(site) {
      const tabs = await chrome.tabs.query({ url: site.pattern });
      await Promise.all(
        tabs.map(async (tab) => {
          if (tab.id === undefined) return;
          try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [site.file] });
          } catch {
            // The tab is gone, or the page refuses scripts. The registered copy
            // will run on its next load.
          }
        }),
      );
    },
  };
}

/**
 * Keeps each site's registered script in line with the one thing that decides it:
 * whether the browser currently grants the site. Granted and not registered:
 * register, and put it into open tabs so the person does not have to reload.
 * Not granted and registered: unregister. Safe to call as often as you like, and
 * it is called at every start, because an update drops registrations made at
 * runtime.
 *
 * `refresh` registers again even if a script is already there, so a new version's
 * file is what runs.
 */
export function createSiteScripts(deps: SiteScriptDeps) {
  // One run at a time: a grant, a start and an update can all ask at once, and a
  // second `register` of the same id is an error.
  let chain: Promise<void> = Promise.resolve();

  async function syncOne(site: FeedSite, refresh: boolean): Promise<void> {
    const granted = await deps.hasPermission(site.pattern);
    const registered = await deps.isRegistered(site.scriptId);
    if (!granted) {
      if (registered) await deps.unregister(site.scriptId);
      return;
    }
    if (registered && !refresh) return;
    if (registered) await deps.unregister(site.scriptId);
    await deps.register(site);
    await deps.injectIntoOpenTabs(site);
  }

  return {
    sync(refresh = false): Promise<void> {
      const run = chain.then(async () => {
        for (const site of FEED_SITES) {
          try {
            await syncOne(site, refresh);
          } catch (error) {
            console.warn(`[AnyFilter] could not sync ${site.id}:`, error instanceof Error ? error.message : error);
          }
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
