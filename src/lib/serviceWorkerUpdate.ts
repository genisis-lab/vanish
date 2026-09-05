// A first install claims the page too. Only an update explicitly accepted in
// this tab may reload it: invite secrets and unsent drafts live in memory.
export function createUpdateReload(reload: () => void) {
  let requested = false
  let reloaded = false
  return {
    request() { requested = true },
    controllerChanged() {
      if (!requested || reloaded) return
      reloaded = true
      reload()
    },
  }
}
