declare namespace chrome {
  namespace events {
    interface Event<L extends (...args: never[]) => unknown> {
      addListener(listener: L): void
      removeListener(listener: L): void
    }
  }

  namespace runtime {
    const id: string
    const lastError: { message?: string } | undefined
    function getURL(path: string): string
    function getManifest(): { version: string; version_name?: string; background?: { service_worker?: string } }
    function reload(): void
    function connectNative(application: string): Port
    function connect(info: { name: string }): Port
    function sendMessage<R = unknown>(message: unknown): Promise<R>
    function getContexts(filter: { contextTypes?: string[]; documentUrls?: string[] }): Promise<{ documentUrl?: string }[]>
    interface MessageSender {
      id?: string
      tab?: tabs.Tab
      frameId?: number
      url?: string
    }
    interface Port {
      readonly name: string
      readonly sender?: MessageSender
      postMessage(message: unknown): void
      disconnect(): void
      readonly onMessage: events.Event<(message: unknown, port: Port) => void>
      readonly onDisconnect: events.Event<(port: Port) => void>
    }
    const onConnect: events.Event<(port: Port) => void>
    const onMessage: events.Event<
      (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | undefined
    >
    const onInstalled: events.Event<(details: { reason: 'install' | 'update' | 'chrome_update' | 'shared_module_update'; previousVersion?: string }) => void>
    const onStartup: events.Event<() => void>
  }

  namespace tabs {
    interface Tab {
      id?: number
      windowId: number
      url?: string
      title?: string
      active: boolean
    }
    function captureVisibleTab(windowId: number, options: { format: 'png' | 'jpeg'; quality?: number }): Promise<string>
    function sendMessage<R = unknown>(tabId: number, message: unknown, options?: { frameId?: number }): Promise<R>
    function create(properties: { url: string; active?: boolean }): Promise<Tab>
    function get(tabId: number): Promise<Tab>
    const onRemoved: events.Event<(tabId: number) => void>
  }

  namespace windows {
    interface Window {
      id?: number
    }
    function create(data: {
      url: string
      type: 'popup' | 'normal'
      width?: number
      height?: number
      focused?: boolean
    }): Promise<Window>
    function remove(windowId: number): Promise<void>
    const onRemoved: events.Event<(windowId: number) => void>
  }

  namespace contextMenus {
    interface OnClickData {
      menuItemId: string | number
      mediaType?: 'image' | 'video' | 'audio'
      srcUrl?: string
      pageUrl?: string
      frameUrl?: string
      frameId?: number
    }
    function create(properties: { id: string; title: string; contexts: ('image' | 'video')[] }): void
    function removeAll(): Promise<void>
    const onClicked: events.Event<(info: OnClickData, tab?: tabs.Tab) => void>
  }

  namespace action {
    const onClicked: events.Event<(tab: tabs.Tab) => void>
  }

  namespace commands {
    const onCommand: events.Event<(command: string, tab?: tabs.Tab) => void>
  }

  namespace scripting {
    function executeScript(injection: {
      target: { tabId: number; frameIds?: number[] }
      files: string[]
    }): Promise<{ frameId: number; result?: unknown }[]>
    function executeScript<A extends unknown[], R>(injection: {
      target: { tabId: number; frameIds?: number[] }
      world: 'MAIN' | 'ISOLATED'
      func: (...args: A) => R
      args: A
    }): Promise<{ frameId: number; result?: Awaited<R> }[]>
  }

  namespace offscreen {
    function createDocument(parameters: { url: string; reasons: ('BLOBS' | 'DOM_PARSER')[]; justification: string }): Promise<void>
  }

  namespace permissions {
    interface Permissions {
      origins?: string[]
      permissions?: string[]
    }
    function request(permissions: Permissions): Promise<boolean>
    function contains(permissions: Permissions): Promise<boolean>
    const onAdded: events.Event<(permissions: Permissions) => void>
  }

  /** Optional: present only once the user grants it. */
  namespace webRequest {
    interface RequestDetails {
      url: string
      tabId: number
      type: string
      timeStamp: number
    }
    const onBeforeRequest: {
      addListener(listener: (details: RequestDetails) => void, filter: { urls: string[]; types?: string[] }): void
      hasListener(listener: (details: RequestDetails) => void): boolean
    }
  }

  namespace storage {
    interface Area {
      get(keys: string | string[]): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
    }
    const local: Area
    const session: Area & { remove(keys: string | string[]): Promise<void> }
  }
}
