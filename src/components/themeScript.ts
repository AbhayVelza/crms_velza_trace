// Theme preference: "light", "dark" or "system" (follow the device), kept in this browser only.
// Shared by the inline <head> script (runs before first paint, so no flash) and ThemeSwitcher.

export type ThemeChoice = "light" | "dark" | "system";

export const THEME_KEY = "velza-theme";
export const THEME_EVENT = "velza-theme-change";

// Sidebar collapsed (desktop): also a device preference, applied as <html data-sidebar="collapsed">.
export const SIDEBAR_KEY = "velza-sidebar";
export const SIDEBAR_EVENT = "velza-sidebar-change";

/**
 * Sets <html data-theme> from the saved choice and keeps following the device setting while the choice
 * is "system", and <html data-sidebar> from the saved sidebar state. Plain ES5 because it runs before any
 * bundle loads.
 */
export const THEME_SCRIPT = `(function(){
var d=document.documentElement,m=window.matchMedia("(prefers-color-scheme: dark)");
function choice(){try{var c=localStorage.getItem("${THEME_KEY}");return c==="light"||c==="dark"?c:"system"}catch(e){return "system"}}
function apply(){var c=choice();d.setAttribute("data-theme",c==="system"?(m.matches?"dark":"light"):c)}
apply();
m.addEventListener("change",apply);
window.addEventListener("${THEME_EVENT}",apply);
window.addEventListener("storage",function(e){if(e.key==="${THEME_KEY}")apply()});
try{if(localStorage.getItem("${SIDEBAR_KEY}")==="collapsed")d.setAttribute("data-sidebar","collapsed")}catch(e){}
})();`;
