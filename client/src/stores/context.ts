import { defineStore } from 'pinia';
import { ref } from 'vue';
export const useContextStore = defineStore('context', () => {
  const collapsed = ref(localStorage.getItem('gw-sidebar') === 'collapsed');
  const mobileMenu = ref(false);
  function toggleSidebar() { collapsed.value = !collapsed.value; localStorage.setItem('gw-sidebar', collapsed.value ? 'collapsed' : 'expanded'); }
  return { collapsed, mobileMenu, toggleSidebar };
});
