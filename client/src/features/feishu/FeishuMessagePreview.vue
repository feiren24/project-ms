<script setup lang="ts">
import type { FeishuMessage } from '../../../../shared/src/feishu';
defineProps<{message:FeishuMessage;historical?:boolean}>();
</script>
<template><article class="fs-message" data-testid="feishu-message-preview"><span class="fs-caption">{{ message.isDemo ? 'DEMO · 示例数据预览' : '当前项目数据预览' }} · {{ historical ? '已保存的消息快照' : '预览不会发送' }}</span><h3>{{ message.title }}</h3><p>{{ message.projectName }} · {{ new Date(message.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) }}</p><p v-if="message.periodStart">统计窗口：{{ message.periodStart }} → {{ message.periodEnd }}</p><ul><li v-for="(line,index) in message.lines" :key="index">{{ line }}</li></ul><p>共 {{ message.total }} 项 · 最多展示 10 项</p><strong v-if="message.mentionAll">@所有人</strong><span v-if="message.url" class="fs-preview-link">{{ message.linkLabel }}</span></article></template>
