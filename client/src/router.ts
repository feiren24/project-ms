import { setProjectScope } from './stores/project-scope';
import { createRouter, createWebHistory } from 'vue-router';
import TaskListPage from './features/tasks/TaskListPage.vue';
import PlanPage from './features/gantt/PlanPage.vue';
import OverviewPage from './features/projects/OverviewPage.vue';
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: { render: () => null } },
    { path: '/account/password', name: 'password', component: { render: () => null } },
    { path: '/account/logout', name: 'logout', component: { render: () => null } },
    { path: '/workspace', name: 'workspace', component: { render: () => null } },
    { path: '/admin/settings', name: 'system-settings', component: { render: () => null } },
    { path: '/admin/users', name: 'users', component: { render: () => null } },
    { path: '/', redirect: '/workspace' },
    { path: '/projects/:projectId/settings', name: 'settings', component: () => import('./features/settings/SettingsPage.vue') },
    { path: '/projects/:projectId/overview', name: 'overview', component: OverviewPage },
    { path: '/projects/:projectId/plan', name: 'plan', component: PlanPage },
    { path: '/projects/:projectId/workstreams', name: 'workstreams', component: () => import('./features/workstreams/WorkstreamPage.vue') },
    { path: '/projects/:projectId/tasks', name: 'tasks', component: TaskListPage },
    { path: '/projects/:projectId/tasks/deleted', name: 'task-recycle', component: () => import('./features/tasks/TaskRecyclePage.vue') },
    { path: '/projects/:projectId/risks', name: 'risks', component: () => import('./features/risks/RiskPage.vue') },
    { path: '/projects/:projectId/risks/:riskId', name: 'risk-detail', component: () => import('./features/risks/RiskPage.vue') },
    { path: '/projects/:projectId/analytics', name: 'analytics', component: () => import('./features/analytics/AnalyticsPage.vue') },
    { path: '/projects/:projectId/tasks/:taskId', name: 'task-detail', component: TaskListPage },
    { path: '/:pathMatch(.*)*', redirect: '/workspace' },
  ],
});

router.afterEach((to, _from, failure) => { if (failure) return; if (typeof to.params.projectId === 'string') setProjectScope(to.params.projectId); document.title = `${to.name === 'login' ? '用户登录' : to.name === 'system-settings' ? '系统设置' : to.name === 'users' ? '用户管理' : to.name === 'workspace' ? '工作空间' : to.name === 'settings' ? '成员与设置' : ['risks','risk-detail'].includes(String(to.name)) ? '风险中心' : to.name === 'analytics' ? '统计分析' : to.name === 'workstreams' ? '工作分组' : to.name === 'plan' ? '完整计划' : ['tasks','task-detail','task-recycle'].includes(String(to.name)) ? '任务管理' : '项目总览'} · GooodWork`; });
export default router;
