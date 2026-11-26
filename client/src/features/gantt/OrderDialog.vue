<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId } from 'vue';
defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>(), titleId = `order-dialog-${useId()}`;
let previous: HTMLElement | null = null;
onMounted(() => { previous = document.activeElement as HTMLElement | null; dialog.value?.showModal(); });
onBeforeUnmount(() => { dialog.value?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); });
</script>
<template>
  <dialog ref="dialog" class="plan-dialog order-dialog" :class="{ 'order-dialog-wide': wide }" :aria-labelledby="titleId" @cancel.prevent="emit('close')">
    <header class="plan-dialog-header"><h2 :id="titleId">{{ title }}</h2><button class="icon-button" :aria-label="`关闭${title}`" @click="emit('close')">×</button></header>
    <div class="plan-dialog-body"><slot /></div>
    <footer class="plan-dialog-footer"><slot name="footer" /></footer>
  </dialog>
</template>
