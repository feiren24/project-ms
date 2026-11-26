import type { ProjectOverview, TaskStatus } from '../../../shared/src/contracts.js';

/** Hand-authored UI review fixture, never imported from the source workbook. */
export type DemoSnapshot = Omit<ProjectOverview, 'summary'>;

const people = [
  { name: '周亦安', initials: '亦安' },
  { name: '陈知远', initials: '知远' },
  { name: '林若宁', initials: '若宁' },
  { name: '许景行', initials: '景行' },
];

const workstreams: ProjectOverview['workstreams'] = [
  { id: 'system-bottom', name: '系统底座', description: '信用、连接与智能能力的公共基础', color: 'blue', start: '2026-09-07', end: '2026-11-13', owner: '周亦安', icon: 'layers' },
  { id: 'b-side', name: '用工方业务', description: '从招聘到履约的用工协作', color: 'cyan', start: '2026-09-07', end: '2026-12-04', owner: '陈知远', icon: 'briefcase' },
  { id: 'c-side', name: '求职者业务', description: '找活、入职与个人职业服务', color: 'purple', start: '2026-09-07', end: '2026-12-11', owner: '林若宁', icon: 'users' },
  { id: 'commercial', name: '收费模式', description: '充值、会员与积分的规则设计', color: 'orange', start: '2026-09-07', end: '2026-11-27', owner: '许景行', icon: 'wallet' },
  { id: 'admin', name: '运营后台', description: '运营管理与数据查看的支持工具', color: 'green', start: '2026-09-07', end: '2026-12-18', owner: '周亦安', icon: 'layout' },
  { id: 'operations', name: '运营筹备', description: '待细化范围的演示拆解，供首页布局评审', color: 'slate', start: '2026-09-07', end: '2026-12-31', owner: '许景行', icon: 'flag' },
];

const taskTitles = [
  ['公共能力范围梳理', '职业信用数据字典', '生态连接器场景清单', '智能体上下文规范', '中文底座交互评审', '统一身份接口联调', '信用数据模型评审', '核心连接器演示验证'],
  ['用工需求流程梳理', '项目工作台原型', '招聘管理状态定义', '排班模块交互评审', '招聘发布流程联调', '人员入场信息核对', '考勤异常处理设计', '结算数据口径评审'],
  ['求职者服务范围梳理', '个人档案原型', '岗位浏览交互评审', '报名状态同步联调', '入职指引页面设计', '个人工作台设计', '服务记录展示设计', '求职者流程联调'],
  ['双端收费场景梳理', '充值与积分规则草案', '会员权益边界评审', '积分明细交互设计', '充值流程原型评审', '费用说明文案整理', '会员状态展示设计', '收费规则演示核对'],
  ['后台范围初步梳理', '运营角色权限草案', '项目概况页面设计', '后台查询条件评审', '运营数据口径核对', '后台信息架构细化', '管理操作反馈设计', '运营后台演示走查'],
  ['筹备问题清单整理', '演示评审议程草案', '试点反馈模板整理', '演示操作指引编写', '业务场景素材整理', '评审问题跟进机制', '上线准备清单草案', '阶段成果演示准备'],
];

const completedByStream = [5, 4, 3, 2, 2, 2];
const activeByStream = [3, 3, 3, 3, 2, 2];

const tasks: ProjectOverview['tasks'] = workstreams.flatMap((stream, streamIndex) =>
  taskTitles[streamIndex]!.map((title, index) => {
    const doneCount = completedByStream[streamIndex]!;
    const activeCount = activeByStream[streamIndex]!;
    const status: TaskStatus = index < doneCount ? 'done' : index < doneCount + activeCount ? 'in_progress' : 'todo';
    const person = people[(streamIndex + index) % people.length]!;
    const overdue = streamIndex < 4 && index === doneCount;
    const due = status === 'done'
      ? `2026-09-${String(10 + index + streamIndex).padStart(2, '0')}`
      : overdue ? '2026-09-18'
      : `2026-${streamIndex < 3 ? '09' : '10'}-${String(streamIndex < 3 ? 22 + index : 5 + index * 2).padStart(2, '0')}`;
    return {
      id: `task-${String(streamIndex * 8 + index + 1).padStart(3, '0')}`,
      title, workstreamId: stream.id, owner: person.name, initials: person.initials, status,
      priority: overdue ? 'P0' : index % 3 === 0 ? 'P2' : 'P1',
      due, progress: status === 'done' ? 100 : status === 'todo' ? 0 : 35 + (index % 4) * 15,
      blocked: overdue && streamIndex < 3,
    };
  }),
);

export const demoSnapshot: DemoSnapshot = {
  mode: 'demo',
  project: {
    id: 'phase-one', name: '我有好活示例项目',
    description: '让阶段目标有路径，让每一次交付有回响。',
    status: '进行中', start: '2026-09-07', end: '2026-12-31', asOf: '2026-09-21',
    isDemo: true,
    sourceLabel: 'DEMO · 虚构任务、成员与进度，仅用于首页 UI 评审',
  },
  workstreams,
  tasks,
  milestones: [
    { id: 'milestone-01', title: '公共能力范围评审', date: '2026-09-14', status: 'done', workstreamId: 'system-bottom', description: '演示记录：范围清单已完成评审。' },
    { id: 'milestone-02', title: '用工方核心流程评审', date: '2026-09-18', status: 'done', workstreamId: 'b-side', description: '演示记录：招聘与项目工作台原型已走查。' },
    { id: 'milestone-03', title: '系统底座接口评审', date: '2026-09-22', status: 'review', workstreamId: 'system-bottom', description: '演示待验收事项：核对统一身份与信用数据接口。' },
    { id: 'milestone-04', title: '招聘流程联调验收', date: '2026-09-25', status: 'upcoming', workstreamId: 'b-side', description: '演示计划：走查发布、报名与人员入场链路。' },
    { id: 'milestone-05', title: '求职者工作台评审', date: '2026-09-29', status: 'upcoming', workstreamId: 'c-side', description: '演示计划：核对个人档案、报名与工作台信息结构。' },
    { id: 'milestone-06', title: '双端收费规则评审', date: '2026-10-05', status: 'upcoming', workstreamId: 'commercial', description: '演示计划：确认充值、会员和积分说明的边界。' },
  ],
  risks: [
    { id: 'risk-01', title: '公共接口联调进度偏慢', level: 'high', owner: '周亦安', due: '2026-09-22', description: 'DEMO：统一身份字段仍需核对，可能影响后续业务联调。', taskIds: ['task-006', 'task-007'] },
    { id: 'risk-02', title: '招聘流程存在依赖阻塞', level: 'high', owner: '陈知远', due: '2026-09-23', description: 'DEMO：发布与入场信息的关联需要补齐，联调任务暂时阻塞。', taskIds: ['task-013', 'task-014'] },
    { id: 'risk-03', title: '报名状态同步尚未闭环', level: 'high', owner: '林若宁', due: '2026-09-24', description: 'DEMO：报名状态与个人工作台的显示口径需要统一。', taskIds: ['task-020', 'task-022'] },
    { id: 'risk-04', title: '会员权益说明待确认', level: 'medium', owner: '许景行', due: '2026-09-25', description: 'DEMO：收费边界仍在评审，需在原型走查前补全说明。', taskIds: ['task-027', 'task-030'] },
  ],
  activities: [
    { id: 'activity-01', actor: '陈知远', initials: '知远', action: '更新了任务进度', target: '招聘发布流程联调', time: '2026-09-21T07:20:00.000Z' },
    { id: 'activity-02', actor: '周亦安', initials: '亦安', action: '提交了评审材料', target: '系统底座接口评审', time: '2026-09-21T06:05:00.000Z' },
    { id: 'activity-03', actor: '林若宁', initials: '若宁', action: '补充了风险说明', target: '报名状态同步尚未闭环', time: '2026-09-21T03:30:00.000Z' },
    { id: 'activity-04', actor: '许景行', initials: '景行', action: '整理了评审问题', target: '会员权益边界评审', time: '2026-09-21T01:10:00.000Z' },
  ],
};
