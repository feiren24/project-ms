<script setup lang="ts">
import { operationReasonPolicy } from '../../../../shared/src/operation-reasons';

import { isProjectManager } from '../../../../shared/src/permissions';

import { useAuthStore } from '../../stores/auth';
const auth = useAuthStore();
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { SettingsWorkspace, SettingsOperation, SettingsMutation, PersonalCapacity } from '../../../../shared/src/settings';
import type { PlanningCalendar } from '../../../../shared/src/planning';
import { fetchSettings, saveSettings } from '../../api/settings';
import { PlanningError } from '../../api/planning';
import { roles, weekdays, hoursLabel } from './labels';
import '../tasks/task-drawer.css';
const props = defineProps<{ workspace: SettingsWorkspace; operation: SettingsOperation; memberId: string; actorId: string }>();
const emit = defineEmits<{ close: []; saved: [workspace: SettingsWorkspace]; updated: [workspace: SettingsWorkspace]; 'actor-change': [actorId: string] }>();
const base = ref(props.workspace), dialog = ref<HTMLDialogElement>();
const sourceMember = props.workspace.members.find(m => m.id === props.memberId);
const sourceCapacity = props.workspace.capacities.find(c => c.memberId === props.memberId);
const member = reactive({ ...(props.operation === 'member_update' ? { id: props.memberId } : {}), name: sourceMember?.name || '', role: sourceMember?.role || 'member' as const, active: sourceMember?.active ?? true });
const calendar = reactive<PlanningCalendar>(JSON.parse(JSON.stringify(props.workspace.calendar)));
const capacity = reactive<PersonalCapacity>({ memberId: props.memberId, hoursPerDay: sourceCapacity?.hoursPerDay ?? null, exceptions: {} });
const unknown = ref(capacity.hoursPerDay === null), capacityHours = ref<number | string>(capacity.hoursPerDay ?? 8);
const exceptions = ref<Array<{ date: string; working: boolean; hours: number | string }>>(Object.entries(props.operation === 'calendar' ? props.workspace.calendar.exceptions : sourceCapacity?.exceptions || {}).map(([date, value]) => ({ date, working: Boolean(value), hours: typeof value === 'number' ? value : 0 })));
const reason = ref(''), busy = ref(false), reloading = ref(false), stale = ref(false), confirmed = ref(false), error = ref(''), notice = ref(''), confirmLeave = ref(false);
const reasonPolicy = computed(() => { const previous = base.value.members.find(m => m.id === props.memberId); return operationReasonPolicy({ domain: 'settings', action: props.operation, previousRole: previous?.role, role: member.role, previousActive: previous?.active, active: member.active }); });
const title = computed(() => ({ member_create: '新增成员', member_update: '编辑成员', calendar: '编辑工作日历', capacity: '设置个人容量' }[props.operation]));
const manager = computed(() => (auth.session?.legacyDemo || !!auth.actorForProject(base.value.project.id)) && (auth.user?.systemRole === 'admin' || base.value.actors.some(a => a.id === props.actorId && isProjectManager(a.role))));
const snapshot = () => JSON.stringify({ member, calendar, unknown: unknown.value, hours: capacityHours.value, exceptions: exceptions.value, reason: reason.value });
const initial = snapshot();
const dirty = computed(() => snapshot() !== initial);
const latestMember = computed(() => base.value.members.find(m => m.id === props.memberId));
const latestCapacity = computed(() => base.value.capacities.find(c => c.memberId === props.memberId));
const dayNames = (values: number[]) => weekdays.filter(d => values.includes(d.value)).map(d => d.label).join('、');
const summary = computed(() => {
  if (props.operation.startsWith('member')) return `${member.name.trim()} · ${roles[member.role]} · ${member.active ? '已启用' : '已停用'}`;
  if (props.operation === 'calendar') return `${dayNames(calendar.weekdays)} · 每天 ${calendar.hoursPerDay} 小时 · ${calendar.confirmed ? '已确认' : '尚未确认'} · ${exceptions.value.length} 个日期例外`;
  return `${sourceMember?.name} · ${hoursLabel(unknown.value ? null : Number(capacityHours.value))} · ${exceptions.value.length} 个日期例外`;
});
const latestSummary = computed(() => {
  if (props.operation === 'member_create') return '新增虚构成员，不会发送邀请或通知。';
  if (props.operation === 'member_update') { const m = latestMember.value; return m ? `${m.name} · ${roles[m.role]} · ${m.active ? '已启用' : '已停用'}` : '原成员已不存在，请关闭后重新选择。'; }
  if (props.operation === 'calendar') { const c = base.value.calendar; return `${dayNames(c.weekdays)} · 每天 ${c.hoursPerDay} 小时 · ${c.confirmed ? '已确认' : '尚未确认'} · ${Object.keys(c.exceptions).length} 个日期例外`; }
  return `${sourceMember?.name} · ${hoursLabel(latestCapacity.value?.hoursPerDay ?? null)} · ${Object.keys(latestCapacity.value?.exceptions || {}).length} 个日期例外`;
});
const latestExceptions = computed(() => props.operation === 'calendar' ? base.value.calendar.exceptions : props.operation === 'capacity' ? latestCapacity.value?.exceptions || {} : {});
let pendingLeave: (() => void) | null = null, resolveNavigation: ((allowed: boolean) => void) | null = null;
function revealLeave() { confirmLeave.value = true; nextTick(() => { const panel = dialog.value?.querySelector<HTMLElement>('.td-leave-panel'); panel?.scrollIntoView({ block: 'nearest' }); panel?.querySelector('button')?.focus(); }); }
function leave() { if (busy.value || reloading.value) return; if (dirty.value) { pendingLeave = () => emit('close'); revealLeave(); } else emit('close'); }
function confirmNavigation(): Promise<boolean> { if (busy.value || reloading.value) return Promise.resolve(false); if (!dirty.value) return Promise.resolve(true); return new Promise(resolve => { resolveNavigation?.(false); resolveNavigation = resolve; pendingLeave = () => { resolveNavigation?.(true); resolveNavigation = null; }; revealLeave(); }); }
function discard() { confirmLeave.value = false; const callback = pendingLeave; pendingLeave = null; callback?.(); }
function keep() { confirmLeave.value = false; pendingLeave = null; resolveNavigation?.(false); resolveNavigation = null; }
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = ''; } }
function validDate(date: string) { return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date; }
function review() {
  error.value = '';
  if (!manager.value || stale.value) return;
  if (reasonPolicy.value === 'required' && !reason.value.trim()) { error.value = '此高危操作须填写原因或依据。'; return; }
  if (props.operation.startsWith('member') && !member.name.trim()) { error.value = '请填写虚构的成员姓名。'; return; }
  if (props.operation === 'calendar' && (!calendar.weekdays.length || !Number.isFinite(Number(calendar.hoursPerDay)) || Number(calendar.hoursPerDay) <= 0 || Number(calendar.hoursPerDay) > 24)) { error.value = '至少选择一个工作日，每天工时应大于 0 且不超过 24。'; return; }
  if (props.operation === 'capacity' && !unknown.value && (capacityHours.value === '' || !Number.isFinite(Number(capacityHours.value)) || Number(capacityHours.value) < 0 || Number(capacityHours.value) > 24)) { error.value = '每日容量需为 0–24 小时，未知请勾选“容量未配置”。'; return; }
  if (['calendar', 'capacity'].includes(props.operation)) {
    if (exceptions.value.some(e => !validDate(e.date)) || new Set(exceptions.value.map(e => e.date)).size !== exceptions.value.length) { error.value = '日期例外需填写有效日期，且同一天只能设置一次。'; return; }
    if (props.operation === 'capacity' && exceptions.value.some(e => e.hours === '' || !Number.isFinite(Number(e.hours)) || Number(e.hours) < 0 || Number(e.hours) > 24)) { error.value = '日期例外工时应为 0–24 小时。'; return; }
  }
  confirmed.value = true;
  nextTick(() => { const panel = dialog.value?.querySelector<HTMLElement>('.settings-preview'); panel?.scrollIntoView({ block: 'start' }); panel?.focus(); });
}
function payload(): SettingsMutation {
  const body: SettingsMutation = { expectedVersion: base.value.version, expectedPlanVersion: base.value.planVersion, reason: reasonPolicy.value === 'required' ? reason.value.trim() : undefined };
  if (props.operation.startsWith('member')) body.member = { ...member, name: member.name.trim() };
  else if (props.operation === 'calendar') body.calendar = { ...calendar, weekdays: [...calendar.weekdays].sort(), hoursPerDay: Number(calendar.hoursPerDay), exceptions: Object.fromEntries(exceptions.value.map(e => [e.date, e.working])) };
  else body.capacity = { memberId: props.memberId, hoursPerDay: unknown.value ? null : Number(capacityHours.value), exceptions: Object.fromEntries(exceptions.value.map(e => [e.date, Number(e.hours)])) };
  return body;
}
let signature = '', requestKey = '';
function changeRecoveryActor(event: Event) {
  const actorId = (event.target as HTMLSelectElement).value;
  if (busy.value || reloading.value || !base.value.actors.some(a => a.id === actorId && isProjectManager(a.role))) return;
  confirmed.value = false; signature = ''; requestKey = ''; error.value = '';
  emit('actor-change', actorId);
  notice.value = '已按你的选择切换体验身份，草稿均保留。请以新身份重新核对变更，再确认保存。';
}

async function save() {
  if (!confirmed.value || busy.value || stale.value || !manager.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  const body = payload(), nextSignature = JSON.stringify({ body, token: base.value.writeToken, actorId: props.actorId });
  if (nextSignature !== signature) { signature = nextSignature; requestKey = crypto.randomUUID(); }
  try { emit('saved', await saveSettings(base.value, props.actorId, props.operation, body, requestKey)); }
  catch (e) { error.value = e instanceof Error ? e.message : '保存失败，草稿已保留，请重试。'; if (e instanceof PlanningError && [403, 409].includes(e.status)) { stale.value = true; confirmed.value = false; error.value += ' 草稿已保留，请先刷新最新设置与操作凭证，再重新核对。'; } }
  finally { busy.value = false; }
}
async function recover() {
  if (reloading.value || busy.value) return;
  reloading.value = true;
  try { base.value = await fetchSettings(props.workspace.project.id); emit('updated', base.value); stale.value = false; confirmed.value = false; error.value = ''; signature = ''; notice.value = '已刷新最新设置与操作凭证，草稿均保留。请对照“当前已保存”与草稿重新核对，不会自动重试保存。'; }
  catch (e) { error.value = `刷新失败，草稿已保留。${e instanceof Error ? e.message : '请重试。'}`; }
  finally { reloading.value = false; }
}
defineExpose({ confirmNavigation });
onMounted(() => { dialog.value?.showModal(); window.addEventListener('beforeunload', beforeUnload); });
onBeforeUnmount(() => { window.removeEventListener('beforeunload', beforeUnload); resolveNavigation?.(false); dialog.value?.close(); });
</script>
<template>
<dialog ref="dialog" class="task-drawer settings-drawer" aria-labelledby="settings-drawer-title" @cancel.prevent="leave" @click="event => { if (event.target === dialog) leave(); }"><div class="td-shell">
 <header class="td-header"><div class="td-header-row"><span class="td-reference">项目配置<span v-if="base.project.isDemo"> · DEMO · 示例项目</span></span><button class="td-icon-button" aria-label="关闭设置抽屉" :disabled="busy || reloading" @click="leave">✕</button></div><h2 id="settings-drawer-title">{{ title }}</h2><p class="td-stream">{{ base.project.name }} · 操作人 {{ base.actors.find(a => a.id === actorId)?.name || '身份已失效' }}</p></header>
 <div class="td-body">
  <section v-if="confirmLeave" class="td-leave-panel" role="alert"><h3>离开将丢弃尚未保存的设置</h3><p>变更草稿尚未保存。</p><div class="td-inline-buttons"><button class="button" @click="keep">继续编辑</button><button class="button" @click="discard">丢弃草稿并离开</button></div></section>
  <div v-if="error" class="td-error" role="alert">{{ error }}<button v-if="stale" class="td-text-button" :disabled="reloading" @click="recover">{{ reloading ? '正在刷新…' : '刷新最新设置并保留草稿' }}</button></div>
  <p v-if="!manager && !auth.session?.legacyDemo" class="td-warning">当前账号已无项目配置权限，草稿已保留。请联系项目负责人恢复权限后重新读取，不会切换为其他人操作。</p><p v-if="notice" class="td-notice" role="status">{{ notice }}</p><section v-if="!manager && auth.session?.legacyDemo" class="settings-access-recovery td-callout td-warning"><h3>当前体验身份已无配置权限</h3><p>草稿均已保留。可明确选择可用的项目负责人体验身份，再重新核对保存；角色切换仅供本机 DEMO。</p><label v-if="base.actors.some(a => isProjectManager(a.role))" class="td-field">切换体验身份并保留草稿<select :value="actorId" aria-label="恢复体验身份" :disabled="busy || reloading" @change="changeRecoveryActor"><option :value="actorId" disabled>请选择可用的项目负责人</option><option v-for="candidate in base.actors.filter(a => isProjectManager(a.role))" :key="candidate.id" :value="candidate.id">{{ candidate.name }} · {{ roles[candidate.role] }}</option></select></label><p v-else>暂时没有可用的项目负责人，请等待权限恢复后刷新。</p><button class="td-text-button" :disabled="busy || reloading" @click="recover">{{ reloading ? '正在刷新…' : '刷新权限并保留草稿' }}</button></section>
  <section class="settings-current"><h3>当前已保存</h3><p>{{ latestSummary }}</p><ul v-if="Object.keys(latestExceptions).length" class="settings-exception-list"><li v-for="[date, value] in Object.entries(latestExceptions).sort()" :key="date">{{ date }} <strong>{{ typeof value === 'boolean' ? value ? '工作日' : '休息日' : `${value} 小时` }}</strong></li></ul><small>设置 V{{ base.version }} · 计划 V{{ base.planVersion }}</small></section>
  <form v-show="!confirmed" id="settings-form" class="td-form" @submit.prevent="review"><fieldset :disabled="busy || reloading || stale || !manager">
   <template v-if="operation.startsWith('member')"><label class="td-field">成员姓名<input v-model="member.name" aria-label="成员姓名" :readonly="operation === 'member_update'" required maxlength="40" placeholder="如：林知夏（虚构）"/><small>{{ operation === 'member_update' ? '姓名保持稳定，避免历史任务与基线归属失真。' : '仅创建本机虚构成员，不会发送邀请。' }}</small></label><label class="td-field">成员角色<select v-model="member.role" aria-label="成员角色"><option v-for="(label, key) in roles" :key="key" :value="key">{{ label }}</option></select></label><label class="td-check"><input v-model="member.active" type="checkbox" aria-label="成员启用状态"/>启用此成员</label><p class="td-field-note">角色与停用限制将在保存时核验。有关联任务、待验收或未关闭风险时，请先移交，不能造成事项无人负责。</p></template>
   <template v-else-if="operation === 'calendar'"><h3>每周工作日</h3><div class="settings-week-checks"><label v-for="day in weekdays" :key="day.value" class="td-check"><input v-model="calendar.weekdays" type="checkbox" :value="day.value" :aria-label="day.label"/>{{ day.label }}</label></div><label class="td-field">每天标准工时<input v-model.number="calendar.hoursPerDay" aria-label="每天标准工时" type="number" min="0.01" max="24" step="any" required/></label><label class="td-check"><input v-model="calendar.confirmed" aria-label="日历已确认" type="checkbox"/>已核对并确认项目工作日历</label><p class="td-field-note">未确认时，只保留规则供核对，不推断真实负荷。</p></template>
   <template v-else><p class="td-prose">配置对象：{{ sourceMember?.name }}</p><label class="td-check"><input v-model="unknown" aria-label="容量未配置" type="checkbox"/>容量未配置（未知）</label><label class="td-field">每日容量（小时）<input v-model="capacityHours" aria-label="每日容量" type="number" :disabled="unknown" min="0" max="24" step="any" :required="!unknown"/><small>0 表示明确无容量；未配置保持未知。只在项目工作日使用基础容量。</small></label></template>
   <section v-if="operation === 'calendar' || operation === 'capacity'" class="td-section"><h3>逐日例外</h3><p class="td-field-note">{{ operation === 'calendar' ? '指定日期优先于每周规则；休息日不提供基础容量。' : '个人日期例外优先于基础容量与项目日历，0 小时表示无容量。' }}</p><div v-for="(entry, index) in exceptions" :key="index" class="settings-exception-edit"><label class="td-field">日期<input v-model="entry.date" type="date" :aria-label="`第 ${index + 1} 条日期例外`" required/></label><label v-if="operation === 'calendar'" class="td-field">当天安排<select v-model="entry.working" :aria-label="`第 ${index + 1} 条例外安排`"><option :value="true">工作日</option><option :value="false">休息日</option></select></label><label v-else class="td-field">容量小时<input v-model="entry.hours" type="number" :aria-label="`第 ${index + 1} 条例外工时`" min="0" max="24" step="any" required/></label><button class="td-text-button" type="button" :aria-label="`移除第 ${index + 1} 条日期例外`" @click="exceptions.splice(index, 1)">移除</button></div><p v-if="!exceptions.length" class="td-empty-inline">暂无日期例外，可按实际安排添加。</p><button class="td-text-button" type="button" @click="exceptions.push({ date: '', working: false, hours: 0 })">＋ 添加日期例外</button></section>
   <label v-if="reasonPolicy === 'required'" class="td-field settings-reason">变更原因<textarea v-model="reason" aria-label="变更原因" required maxlength="1500" rows="3" placeholder="说明本次调整的依据与范围"></textarea></label>
  </fieldset></form>
  <section v-if="confirmed" class="td-action-panel settings-preview" tabindex="-1"><h3>请核对本次变更</h3><p class="td-prose">{{ summary }}</p><ul v-if="exceptions.length && (operation === 'calendar' || operation === 'capacity')" class="settings-exception-list"><li v-for="entry in exceptions" :key="entry.date">{{ entry.date }}<strong>{{ operation === 'calendar' ? entry.working ? '工作日' : '休息日' : `${entry.hours} 小时` }}</strong></li></ul><p v-if="reasonPolicy === 'required'" class="td-prose">原因：{{ reason.trim() }}</p><p class="td-field-note">范围：当前项目{{ operation === 'capacity' ? `的 ${sourceMember?.name} 个人容量` : operation.startsWith('member') ? `的 ${member.name} 成员配置` : '工作日历' }}。变更将保留记录，相关提醒可在站内通知中查看。</p><p class="td-field-note">新配置不会自动修改任务日期或原有基线，不回填历史实际记录。配置变更会提升计划版本、使旧预览失效；请在完整计划核对日期问题，在统计分析核对容量。</p><button class="td-text-button" :disabled="busy" @click="confirmed = false">返回修改</button></section>
 </div>
 <footer class="td-footer"><button class="button" :disabled="busy || reloading" @click="leave">取消</button><button v-if="!confirmed" class="button primary" form="settings-form" :disabled="busy || reloading || stale || !manager">核对变更</button><button v-else class="button primary" :disabled="busy || stale || !manager" @click="save">{{ busy ? '正在保存…' : '确认保存' }}</button></footer>
</div></dialog>
</template>
