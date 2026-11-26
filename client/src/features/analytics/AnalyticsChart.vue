<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { init, use, type EChartsCoreOption, type EChartsType } from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer]);
const props = defineProps<{ option: EChartsCoreOption; label: string }>();
const emit = defineEmits<{ select: [index: number] }>();
const element = ref<HTMLElement>();
let chart: EChartsType | undefined;
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (!element.value) return;
  chart = init(element.value, undefined, { renderer: 'svg' });
  chart.setOption(props.option);
  chart.on('click', (event: unknown) => { const index = (event as { dataIndex?: number }).dataIndex; if (typeof index === 'number') emit('select', index); });
  observer = new ResizeObserver(() => chart?.resize());
  observer.observe(element.value);
});
watch(() => props.option, value => chart?.setOption(value, { notMerge: true }));
onBeforeUnmount(() => { observer?.disconnect(); chart?.dispose(); chart = undefined; });
</script>
<template><div ref="element" class="analytics-chart" role="img" :aria-label="label"></div></template>
