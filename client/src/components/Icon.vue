<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const paths: Record<string, string> = {
  expand: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  chart: 'M4 3v17h17M8 15v-4M13 15V7M18 15V4',
  plan: 'M3 5h18M3 10h5M10 10h7M3 15h8M13 15h8M3 20h5',
  task: 'M9 5h11M9 12h11M9 19h11M3 5l1 1 2-3M3 12l1 1 2-3M3 19l1 1 2-3',
  shield: 'M12 3 4 6v5c0 5 4 8 8 10 4-2 8-5 8-10V6zM12 8v5M12 16h.01',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  chevron: 'm9 5 7 7-7 7', down: 'm6 9 6 6 6-6', arrow: 'M4 12h15M13 6l6 6-6 6',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15M16 16l5 5',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 21h6',
  calendar: 'M4 5h16v16H4zM4 10h16M8 3v4M16 3v4M8 14h2M14 14h2M8 17h2',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2',
  flag: 'M5 21V3M5 4c5-4 9 4 14 0v9c-5 4-9-4-14 0',
  check: 'm5 12 4 4L19 6', close: 'm6 6 12 12M6 18 18 6',
  refresh: 'M20 7a9 9 0 0 0-15-2L3 8M3 3v5h5M4 17a9 9 0 0 0 15 2l2-3M16 16h5v5',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v6M12 7h.01',
  folder: 'M3 6V4h6l2 3h10v13H3z', layers: 'm12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5',
  menu: 'M4 6h16M4 12h16M4 18h16', collapse: 'M9 3v18M3 3h18v18H3zM16 9l-3 3 3 3',
  book: 'M12 5v16M12 5C7 2 3 4 3 4v15s4-2 9 2c5-4 9-2 9-2V4s-4-2-9 1',
  trend: 'm3 17 6-6 4 4 8-10M15 5h6v6', dots: 'M5 12h.01M12 12h.01M19 12h.01',
  users: 'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M2 21v-3a7 7 0 0 1 14 0v3M17 4a4 4 0 0 1 0 8M19 15a5 5 0 0 1 3 5',
  code: 'm8 7-5 5 5 5M16 7l5 5-5 5M14 3l-4 18',
  briefcase: 'M3 7h18v14H3zM8 7V3h8v4M3 12l9 3 9-3M12 12v5',
  wallet: 'M3 5h16v4M3 5v15h18V9H3M16 13h5v4h-5z',
  server: 'M3 3h18v7H3zM3 14h18v7H3zM7 6h.01M7 17h.01',
  compass: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m4 5-2 6-6 2 2-6z',
};
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.folder" /></svg></template>
