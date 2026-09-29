# LIVO 开发编码准则

> 适用对象：所有开发者（含 AI 助手）。每次新增功能或修改代码前应先阅读并遵循本文件。

---

## 1. TypeScript 规范

### 零 any 政策
- **禁止使用 `any`**，不允许 `// @ts-ignore` 绕过类型检查。
- 类型不明确时，使用 `unknown` + 类型守卫（`typeof`、`instanceof`、自定义 `is` 函数）。
- 与 Supabase 查询结果交互时，过渡类型用 `as Record<string, unknown>`，长期目标是通过 `supabase gen types typescript` 生成完整 `Database` 类型并替换所有手写类型。

### 命名规范
| 类型 | 规范 | 示例 |
|------|------|------|
| 组件 | PascalCase | `TaskCard`, `SprintBoard` |
| Hooks | useCamelCase | `useTaskFilters`, `useMemberList` |
| 类型 / 接口 | PascalCase | `TaskRow`, `SprintMeta` |
| 普通函数 / 变量 | camelCase | `fetchTasks`, `isLoading` |
| 常量 | SCREAMING_SNAKE_CASE | `MAX_SPRINT_DAYS` |

### 构建前类型检查
每次构建前必须通过：
```bash
npx tsc --noEmit
```
存在类型错误时禁止构建并发布。

---

## 2. 组件架构规范

### 文件大小限制
- 单文件**不超过 500 行**（纯数据 / 配置文件除外）。
- 超过 500 行必须拆分为：
  - **薄编排器**（Orchestrator）：只负责组合子组件、传递 props、layout。
  - **子组件**或**子 hooks**：各自封装独立逻辑。

### 懒加载
- 所有大型路由视图（Board、Backlog 等）必须使用 `React.lazy` + `Suspense`：
  ```tsx
  const BoardView = React.lazy(() => import('./BoardView'));
  ```

### 虚拟滚动
- 列表项**超过 100 条**必须使用 `@tanstack/react-virtual` 虚拟滚动，禁止全量渲染。

---

## 3. 状态管理规范

### Context 拆分
Context 按领域拆分，禁止将不相关状态合并进单一 Context：

| Context | 管理内容 |
|---------|---------|
| `AuthContext` | 登录态、session、用户信息 |
| `MemberContext` | 成员列表、权限 |
| `UIContext` | 主题、sidebar 展开态、modal 状态 |
| `ProjectContext` | 当前项目、项目列表 |
| `TaskContext` | 任务列表、任务 CRUD |
| `SprintContext` | Sprint 列表、当前 Sprint |

### Context value 必须 useMemo
```tsx
const value = useMemo(() => ({ tasks, addTask, updateTask }), [tasks]);
```
禁止直接传递对象字面量，避免无谓的子树重渲染。

### 字段注册
新增自定义字段必须同步加入 `fieldRegistry`（字段元数据注册表）和筛选器配置，确保筛选、排序、导出逻辑自动支持新字段。

---

## 4. 安全规范

### XSS 防护
- 使用 `dangerouslySetInnerHTML` 之前**必须**通过 `DOMPurify.sanitize()` 净化：
  ```tsx
  <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />
  ```
- 禁止直接渲染用户输入的原始 HTML。

### 密钥管理
- 禁止在代码中硬编码 Supabase URL、anon key 或任何密钥。
- 必须通过 `import.meta.env.VITE_*` 读取，变量在对应 `.env` 文件中定义。

### 调试页面守卫
- `SeedPage` 等仅供开发调试的页面必须用环境变量守卫：
  ```tsx
  if (!import.meta.env.DEV) return <Navigate to="/" />;
  ```

### 日志规范
- **禁止**在生产代码中保留 `console.log`。
- 可观测性日志使用 `console.warn`（预期外但可恢复）或 `console.error`（需要介入的错误）。

---

## 5. 错误处理规范

- **禁止空 catch** 或静默 catch：
  ```ts
  // 错误示范
  try { ... } catch (_) {}

  // 正确示范
  try { ... } catch (err) {
    console.warn('[模块名] 操作失败', err);
    toast.error('操作失败，请稍后重试');
  }
  ```
- catch 内至少要有 `console.warn` 日志记录上下文和错误原因。
- **用户触发的操作失败**必须通过 `toast.error` 给予反馈，禁止静默失败。

---

## 6. 构建规范

每次代码变更必须构建**两个版本**，版本号一致：

```bash
# 本地版（连接 localhost Docker Supabase）
npx vite build --mode localdb --outDir dist-vXX

# 云端版（连接 Supabase Cloud）
npx vite build --outDir dist-vXX-cloud
```

- **禁止**直接运行 `npx vite build` 后当本地版使用，`.env.production` 会覆盖本地 URL。
- `--mode localdb` 让 Vite 读 `.env.localdb`，这是唯一正确的本地构建方式。
- `.env.localdb` 必须包含 `VITE_LOCAL_MODE=true`，`.env.production` 的 `VITE_LOCAL_MODE` 必须为 `false`。
- 构建前先运行 `npx tsc --noEmit` 确保无类型错误。

详见 `CLAUDE.md` 中的构建规则章节。

---

## 7. 性能规范

| 场景 | 措施 |
|------|------|
| 计算密集的派生值 | `useMemo` |
| 需要引用稳定的回调 | `useCallback` |
| 频繁重渲染的叶子组件 | `React.memo` |
| 列表项超过 100 条 | `@tanstack/react-virtual` 虚拟滚动 |

- 不要过度使用 `useMemo` / `useCallback`，仅在有明确性能需求时使用。
- 避免在渲染路径中执行昂贵的同步计算；必要时移至 Web Worker 或服务端。

---

## 8. 数据库变更规范

涉及数据库变更（新建表、加字段、改 RLS、新增函数）时，必须：

1. 在 `LIVO-local-ready/supabase/migrations/` 下创建 migration 文件。
2. 文件命名：`YYYYMMDD_描述.sql`（如 `20260401_add_task_tags.sql`）。
3. 在本地 Docker Supabase（`http://localhost:8000` SQL Editor 或 psql `localhost:7432`）和云端 Supabase 两边都执行。
4. 执行后更新 `supabase/migrations/APPLIED.md` 的执行状态记录。
5. 开始新任务前先检查 `APPLIED.md`，确认云端是否有未执行的 migration。

详见 `CLAUDE.md` 中的数据库变更规则章节。

---

## 快速核查清单

提交代码前过一遍：

- [ ] 无 `any` 类型，无 `@ts-ignore`
- [ ] `npx tsc --noEmit` 通过
- [ ] 无 `console.log` 残留
- [ ] 新增组件 < 500 行，超出已拆分
- [ ] 用户操作失败有 toast 反馈
- [ ] 无硬编码密钥
- [ ] 已构建本地版 + 云端版（版本号一致）
- [ ] 数据库变更已写 migration 文件并更新 APPLIED.md
