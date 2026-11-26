<script lang="ts">
import { useProjectView, currentProjectId } from '../../stores/project-scope';
const defaultView = () => ({ tab: 'members', actor: 'zhou' });
</script>
<script setup lang="ts">
import { isProjectManager } from '../../../../shared/src/permissions';

import { useAuthStore } from '../../stores/auth';
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router';
import FeishuPanel from '../feishu/FeishuPanel.vue';
import type { SettingsOperation, SettingsWorkspace } from '../../../../shared/src/settings';
import { fetchSettings } from '../../api/settings';
import SettingsDrawer from './SettingsDrawer.vue';
import { roles, weekdays, hoursLabel, dateTime } from './labels';
import './settings-page.css';
import MembershipDialog from '../projects/MembershipDialog.vue';
import RemoveMemberDialog from '../projects/RemoveMemberDialog.vue';
import ProjectFormDialog from '../projects/ProjectFormDialog.vue';
import { fetchProject } from '../../api/projects';
import type { ProjectInfo } from '../../../../shared/src/projects';
import type { ProjectMember } from '../../../../shared/src/settings';
const view = useProjectView('settings', defaultView);
const pageProjectId = currentProjectId();
const route = useRoute(), feishu = ref<InstanceType<typeof FeishuPanel>>();
if (route.query.tab === 'integrations') view.tab = 'integrations';
async function changeTab(tab: string) { if (view.tab === 'integrations' && !(await (feishu.value?.confirmNavigation() ?? true))) return; view.tab = tab; }
let disposed = false;
onBeforeUnmount(() => { disposed = true; });
const auth = useAuthStore();
const isLegacy = computed(() => Boolean(auth.session?.legacyDemo));
watch(() => auth.actorForProject(pageProjectId), id => { if (!isLegacy.value) view.actor = id; }, { immediate: true });
const emit = defineEmits<{ 'overview-changed': []; notify: [message: string] }>();
const removingMember = ref<ProjectMember>();
const memberQuery = ref(''), memberRole = ref(''), memberState = ref('current');
const currentMembers = computed(() => workspace.value?.members.filter(m => !m.removedAt) || []);
const displayedMembers = computed(() => (workspace.value?.members || []).filter(m => (memberState.value === 'removed' ? !!m.removedAt : !m.removedAt) && (!memberRole.value || m.role === memberRole.value) && `${m.name} ${m.username || ''}`.toLowerCase().includes(memberQuery.value.trim().toLowerCase())));
const projectInfo = ref<ProjectInfo>(), editingProject = ref(false), addingMember = ref(false), legacyMember = ref<ProjectMember>();
const workspace = ref<SettingsWorkspace | null>(null), loading = ref(false), error = ref(''), actorNotice = ref('');
const operation = ref<SettingsOperation | null>(null), selectedMember = ref(''), drawer = ref<InstanceType<typeof SettingsDrawer>>();
const manager = computed(() => (isLegacy.value || !!auth.actorForProject(pageProjectId)) && (auth.user?.systemRole === 'admin' || workspace.value?.actors.some(a => a.id === view.actor && isProjectManager(a.role))));
const memberName = (id: string) => workspace.value?.members.find(m => m.id === id)?.name || id;
const capacity = (id: string) => workspace.value?.capacities.find(c => c.memberId === id);
async function load() {
  if (loading.value || disposed) return;
  loading.value = true; error.value = '';
  try { const result = await fetchSettings(pageProjectId); if (disposed) return; workspace.value = result; if (!isLegacy.value) { const info = await fetchProject(pageProjectId); if (disposed) return; projectInfo.value = info; } if (!workspace.value.actors.some(a => a.id === view.actor)) { view.actor = ''; actorNotice.value = isLegacy.value ? '原体验身份已停用或不可用，请重新选择体验身份。' : '当前账号的项目权限已失效，请联系项目负责人。'; } }
  catch (e) { if (disposed) return; error.value = e instanceof Error ? e.message : '读取失败，请重试。'; }
  finally { if (!disposed) loading.value = false; }
}
function open(value: SettingsOperation, memberId = '') { selectedMember.value = memberId; operation.value = value; }
function saved(value: SettingsWorkspace) { workspace.value = value; operation.value = null; emit('overview-changed'); emit('notify', '设置已保存，变更记录已更新。'); }
async function confirmNavigation() { return (await (drawer.value?.confirmNavigation() ?? true)) && (await (feishu.value?.confirmNavigation() ?? true)); }
onBeforeRouteLeave(confirmNavigation);
onBeforeRouteUpdate(async (to,from) => { if (to.params.projectId !== from.params.projectId) return confirmNavigation(); if (to.query.tab === 'integrations') view.tab = 'integrations'; return true; });
async function memberRemoved() { removingMember.value=undefined; await auth.refreshForRecovery(); if (disposed) return; await load(); if (disposed) return; emit('overview-changed'); emit('notify', '成员已移除，历史记录与其他项目权限保留。'); }
async function membershipSaved() { addingMember.value=false; legacyMember.value=undefined; await auth.refreshForRecovery(); if (disposed) return; view.actor=auth.actorForProject(pageProjectId); await load(); if (disposed) return; emit('overview-changed'); emit('notify','项目成员已更新，账号关联与操作记录已保存。'); }
async function projectSaved(project: ProjectInfo) { editingProject.value=false; projectInfo.value=project; await load(); if (disposed) return; emit('overview-changed'); emit('notify','项目资料已保存，任务日期和历史基线保持。'); }
onMounted(load);
defineExpose({ refreshForCollaboration: async () => { if (feishu.value?.hasDraft()) return false; await load(); await feishu.value?.refresh(); return !disposed && !error.value; } });
</script>
<template>
<section class="settings-page" aria-labelledby="settings-title">
 <header class="settings-header"><div><span class="eyebrow">MEMBERS & SETTINGS</span><h1 id="settings-title">成员与设置<span></span></h1><p>明确协作角色，让工作日历与个人投入有据可依。</p></div><button class="button" :disabled="loading || !!operation" @click="load">{{ loading ? '正在读取…' : '刷新设置' }}</button></header>
 <div v-if="workspace?.project.isDemo" class="settings-demo"><span class="demo-label">DEMO</span><p>{{ workspace?.project.name || '当前项目' }} · 仅本机配置持久保存。<small>{{ isLegacy ? '体验身份仅用于隔离测试。' : `当前登录：${auth.user?.name || ''}，权限由项目角色决定。` }}</small></p><label v-if="isLegacy">体验身份<select v-model="view.actor" aria-label="设置体验身份" :disabled="!!operation || loading" @change="actorNotice = ''"><option value="" disabled>请选择体验身份</option><option v-for="actor in workspace?.actors || []" :key="actor.id" :value="actor.id">{{ actor.name }} · {{ roles[actor.role] }}</option></select></label></div>
 <div v-if="error" class="settings-error" role="alert">{{ error }}<button class="button" :disabled="loading" @click="load">重新加载</button></div>
 <p v-if="loading && !workspace" class="settings-empty" role="status">正在读取成员、工作日历与个人容量…</p>
 <template v-if="workspace">
  <p v-if="actorNotice" class="settings-notice" role="status">{{ actorNotice }}</p><p v-if="!manager" class="settings-notice">此页面仅可查看。成员、工作日历与个人容量由项目负责人或管理员维护。</p>
  <div class="settings-summary"><article><span>启用成员</span><strong>{{ currentMembers.filter(m => m.active).length }}<small> / {{ currentMembers.length }}</small></strong><p>停用保留历史记录</p></article><article><span>工作日历</span><strong>{{ workspace.calendar.confirmed ? '已确认' : '待确认' }}</strong><p>{{ workspace.calendar.confirmed ? '用于当前计划与负荷分析' : '尚不能推断真实负荷' }}</p></article><article><span>个人容量已配置</span><strong>{{ currentMembers.filter(m => m.active && capacity(m.id)?.hoursPerDay != null).length }}<small> / {{ currentMembers.filter(m => m.active).length }}</small></strong><p>未配置保持未知，0 表示无容量</p></article></div>
  <div class="settings-tabs"><nav aria-label="设置分类"><button v-for="tab in [{ id: 'members', label: '项目成员' }, ...(!isLegacy ? [{ id: 'project', label: '项目设置' }] : []), { id: 'calendar', label: '工作日历' }, { id: 'capacity', label: '个人容量' }, ...(manager ? [{ id: 'integrations', label: '通知与集成' }] : [])]" :key="tab.id" :aria-pressed="view.tab === tab.id" :class="{ active: view.tab === tab.id }" @click="changeTab(tab.id)">{{ tab.label }}</button></nav><span>设置 V{{ workspace.version }} · 计划 V{{ workspace.planVersion }}</span></div>
  <section v-if="view.tab === 'members'" class="settings-panel" aria-labelledby="members-title"><div class="settings-panel-heading"><div><h2 id="members-title">项目成员</h2><p>{{ isLegacy ? '虚构示例成员；新增后姓名保持稳定，角色与状态可调整。' : '从已有登录账号添加成员。旧成员须明确关联账号，保留原有任务与历史责任。' }}</p></div><button v-if="manager" class="button primary" aria-label="添加项目成员" @click="isLegacy ? open('member_create') : (legacyMember=undefined,addingMember=true)">＋ 添加项目成员</button></div>
   <div class="settings-member-filters"><label>搜索成员<input v-model="memberQuery" type="search" placeholder="姓名或登录账号"/></label><label>项目角色<select aria-label="项目角色筛选" v-model="memberRole"><option value="">全部角色</option><option v-for="(label, role) in roles" :key="role" :value="role">{{ label }}</option></select></label><label>成员范围<select aria-label="成员范围" v-model="memberState"><option value="current">当前成员</option><option value="removed">已移除成员</option></select></label></div>
   <p class="settings-footnote">项目成员可创建并分派任务；只读成员仅可浏览项目。</p>
   <article v-for="member in displayedMembers" :key="member.id" class="settings-member" data-testid="member-row"><span class="avatar avatar-blue">{{ member.name.slice(0, 1) }}</span><div><strong>{{ member.name }}</strong><small>{{ roles[member.role] }}{{ member.id === view.actor ? (isLegacy ? ' · 当前体验身份' : ' · 当前登录用户') : '' }}</small><p v-if="!isLegacy" class="member-login-note">{{ member.userId ? `登录账号：${member.username} · ${member.accountActive ? '账号已启用' : '账号已停用'}` : '未关联登录账号' }}</p></div><span class="settings-status" :class="{ inactive: !member.active }">{{ member.removedAt ? '已移除' : member.active ? '已启用' : '已停用' }}</span><div v-if="manager && !member.removedAt" class="member-actions"><button class="settings-link" :aria-label="`编辑成员 ${member.name}`" @click="open('member_update', member.id)">编辑</button><button v-if="!isLegacy && member.id !== view.actor" class="settings-link member-remove" :aria-label="`移除成员 ${member.name}`" @click="removingMember=member">移除</button><button v-if="!isLegacy && !member.userId && auth.user?.systemRole==='admin'" class="settings-link" :aria-label="`关联账号 ${member.name}`" @click="legacyMember=member;addingMember=true">关联账号</button></div></article>
   <p v-if="!displayedMembers.length" class="settings-empty">没有符合条件的成员，请调整搜索、角色或成员范围。</p>
   <p class="settings-footnote">最后一名负责人及当前操作者不可降级或停用。仍承担未完成任务、待验收或风险责任的成员，需先移交相关事项。</p>
  </section>
  <section v-else-if="view.tab === 'project' && projectInfo" class="settings-panel project-profile"><div class="settings-panel-heading"><div><h2>项目基本资料</h2><p>明确目标与计划窗口，保持项目上下文一致。</p></div><button v-if="manager" class="button primary" @click="editingProject=true">编辑项目资料</button></div><dl class="project-facts"><div><dt>项目名称</dt><dd>{{ projectInfo.name }}</dd></div><div><dt>项目目标</dt><dd>{{ projectInfo.goal }}</dd></div><div><dt>计划窗口</dt><dd>{{ projectInfo.start }} → {{ projectInfo.end }}</dd></div></dl></section>
  <section v-else-if="view.tab === 'calendar'" class="settings-panel" aria-labelledby="calendar-title"><div class="settings-panel-heading"><div><h2 id="calendar-title">项目工作日历</h2><p>每周规则与逐日例外共同决定项目工作日。</p></div><button v-if="manager" class="button primary" @click="open('calendar')">编辑工作日历</button></div><div class="settings-calendar"><div class="settings-week"><span v-for="day in weekdays" :key="day.value" :class="{ working: workspace.calendar.weekdays.includes(day.value) }">{{ day.label }}<small>{{ workspace.calendar.weekdays.includes(day.value) ? '工作' : '休息' }}</small></span></div><div class="settings-facts"><p>每天标准工时 <strong>{{ workspace.calendar.hoursPerDay }} 小时</strong></p><p>日历状态 <strong>{{ workspace.calendar.confirmed ? '已确认' : '尚未确认' }}</strong></p></div><p v-if="!workspace.calendar.confirmed" class="settings-notice">当前日历尚未确认。显示的默认规则仅供核对，不能据此认定真实出勤或负荷。</p><h3>逐日例外</h3><ul v-if="Object.keys(workspace.calendar.exceptions).length" class="settings-exception-list"><li v-for="[date, working] in Object.entries(workspace.calendar.exceptions).sort()" :key="date"><span>{{ date }}</span><strong>{{ working ? '工作日' : '休息日' }}</strong></li></ul><p v-else class="settings-muted">尚未设置日期例外。如有调休或加班，可通过“编辑工作日历”添加。</p></div><p class="settings-footnote">新日历会更新计划版本并使旧预览失效；不会自动修改任务日期、原有基线或历史实际快照。请到完整计划查看日期问题。</p></section>
  <FeishuPanel v-else-if="view.tab === 'integrations'" ref="feishu" :project-id="pageProjectId" :actor-id="view.actor" @notify="emit('notify', $event)"/>
  <section v-else class="settings-panel" aria-labelledby="capacity-title"><div class="settings-panel-heading"><div><h2 id="capacity-title">个人每日容量</h2><p>项目工作日采用基础容量；个人日期例外优先，0 小时可表示请假。</p></div></div><p v-if="!workspace.calendar.confirmed" class="settings-notice settings-inset">工作日历尚未确认；即使已填写容量，也不能推断真实负荷。</p><article v-for="member in currentMembers" :key="member.id" class="settings-capacity" data-testid="capacity-row"><div><strong>{{ memberName(member.id) }}<small v-if="!member.active"> · 已停用</small></strong><span>{{ hoursLabel(capacity(member.id)?.hoursPerDay ?? null) }}</span><p>{{ Object.keys(capacity(member.id)?.exceptions || {}).length }} 个日期例外</p><p v-if="!member.active">已停用，需先启用成员才能调整容量。</p><ul v-if="Object.keys(capacity(member.id)?.exceptions || {}).length" class="settings-exception-list"><li v-for="[date, hours] in Object.entries(capacity(member.id)?.exceptions || {}).sort()" :key="date">{{ date }} <strong>{{ hours }} 小时</strong></li></ul></div><button v-if="manager" class="settings-link" :aria-label="`设置容量 ${member.name}`" :disabled="!member.active" :title="!member.active ? '请先启用成员，再设置容量' : undefined" @click="open('capacity', member.id)">设置容量</button></article><p class="settings-footnote">未配置容量保持未知，不当作 0。容量用于当前计划分析，不回填历史实际记录；统计分析可选择“已配置个人容量”口径。</p></section>
  <section v-if="view.tab !== 'integrations'" class="settings-panel settings-audit" aria-labelledby="settings-audit-title"><div class="settings-panel-heading"><div><h2 id="settings-audit-title">设置变更记录</h2><p>保留操作者、时间、原因与变化摘要。</p></div><span>{{ workspace.events.length }} 条</span></div><article v-for="event in workspace.events" :key="event.id"><div><strong>{{ event.actor }}</strong><time>{{ dateTime(event.createdAt) }}</time></div><p>{{ event.summary }}</p><small>原因：{{ event.reason }}</small></article><p v-if="!workspace.events.length" class="settings-empty">尚无设置变更。负责人确认保存后将在这里显示记录。</p></section>
  <footer class="settings-footer">变更保留记录 · 协作提醒通过站内通知查看 · 原任务日期与历史基线保留</footer>
  <RemoveMemberDialog v-if="removingMember" :project-id="pageProjectId" :member="removingMember" @close="removingMember=undefined" @saved="memberRemoved"/>
  <MembershipDialog v-if="addingMember" :project-id="pageProjectId" :legacy-member="legacyMember" @close="addingMember=false;legacyMember=undefined" @saved="membershipSaved"/>
  <ProjectFormDialog v-if="editingProject&&projectInfo" :project="projectInfo" :plan-version="workspace.planVersion" @close="editingProject=false" @saved="projectSaved"/>
  <SettingsDrawer v-if="operation" ref="drawer" :workspace="workspace" :operation="operation" :member-id="selectedMember" :actor-id="view.actor" @close="operation = null" @saved="saved" @updated="workspace = $event" @actor-change="view.actor = $event; actorNotice = ''"/>
 </template>
</section>
</template>
