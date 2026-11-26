<script setup lang="ts">
withDefaults(defineProps<{ compact?: boolean; size?: 'small' | 'large'; subtitle?: string }>(), {
  compact: false, size: 'small', subtitle: '我有好活 · 项目管理',
});
</script>

<template>
  <span class="brand-logo" :class="[`brand-logo--${size}`, { 'brand-logo--compact': compact }]" role="img" :aria-label="`GooodWork · ${subtitle}`">
    <img class="brand-logo-icon" src="/brand/gooodwork-mark.svg" alt="" aria-hidden="true" width="48" height="48" />
    <span v-if="!compact" class="brand-copy" aria-hidden="true">
      <img class="brand-logo-word" src="/brand/gooodwork-wordmark.svg" alt="" width="250" height="54" />
      <span class="brand-logo-subtitle">{{ subtitle }}</span>
    </span>
  </span>
</template>

<style>
.brand-logo{--brand-icon:32px;--brand-copy:116px;--brand-gap:8px;display:inline-flex;align-items:center;gap:var(--brand-gap);max-width:100%;vertical-align:middle;flex-shrink:0}
.brand-logo-icon{width:var(--brand-icon);height:var(--brand-icon);flex:none;display:block}
.brand-copy{width:var(--brand-copy);min-width:0;display:flex;flex-direction:column;gap:3px}
.brand-logo-word{display:block;width:100%;height:auto}
.brand-logo-subtitle{font-size:9px;line-height:1.5;font-weight:500;color:var(--secondary);white-space:nowrap;letter-spacing:.3px}
.brand-logo--large{--brand-icon:44px;--brand-copy:160px;--brand-gap:12px}
.brand-logo--large .brand-logo-subtitle{font-size:11px;letter-spacing:.5px}
.brand-logo--compact{gap:0}
@media(max-width:360px){.brand-logo--large{--brand-icon:36px;--brand-copy:144px;--brand-gap:10px}.brand-logo--large .brand-logo-subtitle{font-size:10px}}
</style>
