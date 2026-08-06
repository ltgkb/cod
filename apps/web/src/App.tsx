import { useEffect, useMemo, useState } from 'react';
import {
  ArrowsClockwise,
  CaretDown,
  ChatCircleDots,
  Check,
  CircleNotch,
  Code,
  Command,
  File,
  Folder,
  GitDiff,
  Lightning,
  ArrowSquareOut,
  ListChecks,
  MagnifyingGlass,
  PaperPlaneTilt,
  Plus,
  ShieldCheck,
  SidebarSimple,
  TerminalWindow,
  UserCircle,
  Warning,
} from '@phosphor-icons/react';
import type { CodTask, TaskStatus, WorkspaceFile } from '@cod/contracts';
import { createRemoteTask, listDevices, listProducts, loadCodSession, registerDevice, searchKnowledge, sendChat, topup, type CodSession } from './api';
import type { DeviceRecord, KnowledgeHit, ProductManifest } from '@cod/contracts';
import { demoDiff, demoFiles, demoTasks, demoTimeline } from './demoData';
import { hasDesktopBridge, openProject, readProjectFile } from './desktop';
import type { InspectorTab, ProjectSnapshot, WorkspaceMode } from './types';

const statusLabels: Record<TaskStatus, string> = {
  draft: '草稿',
  running: '运行中',
  waiting: '待确认',
  complete: '已完成',
  failed: '失败',
};

function Brand() {
  return (
    <div className="brand" aria-label="COD">
      <div className="brand-mark"><span>C</span></div>
      <div>
        <strong>COD</strong>
        <small>agent workspace</small>
      </div>
    </div>
  );
}

function StatusGlyph({ status }: { status: TaskStatus }) {
  if (status === 'running') return <CircleNotch className="spin status-running" weight="bold" />;
  if (status === 'waiting') return <Warning className="status-waiting" weight="fill" />;
  if (status === 'failed') return <Warning className="status-failed" weight="fill" />;
  if (status === 'complete') return <Check className="status-complete" weight="bold" />;
  return <ListChecks />;
}

function TaskList({ tasks, activeId, onSelect }: { tasks: CodTask[]; activeId: string; onSelect: (id: string) => void }) {
  return (
    <nav className="task-list" aria-label="任务列表">
      {tasks.map((task) => (
        <button
          className={task.id === activeId ? 'task-row active' : 'task-row'}
          key={task.id}
          onClick={() => onSelect(task.id)}
        >
          <StatusGlyph status={task.status} />
          <span className="task-copy">
            <strong>{task.title}</strong>
            <small>{task.project} <i>/</i> {task.updatedAt}</small>
          </span>
          <span className={`task-status ${task.status}`}>{statusLabels[task.status]}</span>
        </button>
      ))}
    </nav>
  );
}

function FileTree({ files, selected, onSelect }: { files: WorkspaceFile[]; selected: string | null; onSelect: (file: WorkspaceFile) => void }) {
  return (
    <div className="file-tree">
      {files.map((file) => (
        <button
          key={file.path}
          className={selected === file.path ? 'file-row active' : 'file-row'}
          style={{ paddingLeft: `${12 + file.depth * 14}px` }}
          onClick={() => onSelect(file)}
        >
          {file.kind === 'directory' ? <Folder weight="fill" /> : <File />}
          <span>{file.name}</span>
        </button>
      ))}
    </div>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="code-block">
      {text.split('\n').map((line, index) => {
        const type = line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : '';
        return <code className={type} key={`${index}-${line}`}>{line || ' '}</code>;
      })}
    </pre>
  );
}

export function App() {
  const [mode, setMode] = useState<WorkspaceMode>('code');
  const [activeTask, setActiveTask] = useState(demoTasks[0].id);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('changes');
  const [prompt, setPrompt] = useState('');
  const [command, setCommand] = useState('npm test');
  const [terminalOutput, setTerminalOutput] = useState('$ npm test\n等待执行权限');
  const [session, setSession] = useState<CodSession | null>(null);
  const [accountError, setAccountError] = useState(false);
  const [selectedModel, setSelectedModel] = useState('coder-pro');
  const [knowledgeHits, setKnowledgeHits] = useState<KnowledgeHit[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [remoteNotice, setRemoteNotice] = useState('');
  const [products, setProducts] = useState<ProductManifest[]>([]);
  const [activeProduct, setActiveProduct] = useState<ProductManifest | null>(null);
  const [chatReply, setChatReply] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [project, setProject] = useState<ProjectSnapshot>({
    root: '/home/ubuntu/cod-project/cod',
    files: demoFiles,
    diff: demoDiff,
    selectedFile: 'apps/web/src/App.tsx',
    selectedContent: 'export function App() {\n  return <main className="workspace" />;\n}\n',
  });

  const active = useMemo(() => demoTasks.find((task) => task.id === activeTask) ?? demoTasks[0], [activeTask]);

  useEffect(() => {
    loadCodSession()
      .then((next) => {
        setSession(next);
        setSelectedModel(next.models[0]?.id ?? 'coder-pro');
        return Promise.all([
          listDevices(next.token).then(async (items) => items.length ? items : [await registerDevice(next.token, 'COD Desktop', 'linux')]).then(setDevices),
          listProducts(next.token).then(setProducts),
        ]);
      })
      .catch(() => setAccountError(true));
  }, []);

  const handleTopup = async () => {
    if (!session) return;
    const account = await topup(session.token, 1000);
    setSession({ ...session, account });
  };

  const handleKnowledge = async () => {
    if (!session) return;
    setKnowledgeHits(await searchKnowledge(session.token, prompt || 'Agent 权限'));
  };

  const handleRemoteTask = async () => {
    if (!session) return;
    const device = devices[0] ?? await registerDevice(session.token, 'COD Desktop', 'linux');
    const task = await createRemoteTask(session.token, prompt || '从手机继续当前任务', device.id);
    setRemoteNotice(`已发送到 ${device.name}，任务状态：${statusLabels[task.status]}`);
  };

  const handleSend = async () => {
    if (!prompt.trim() || !session) return;
    setIsSending(true);
    try {
      setChatReply(await sendChat(session.token, selectedModel, prompt));
      setPrompt('');
    } finally {
      setIsSending(false);
    }
  };

  const handleOpenProject = async () => {
    const snapshot = await openProject();
    if (snapshot) setProject(snapshot);
  };

  const handleFileSelect = async (file: WorkspaceFile) => {
    if (file.kind !== 'file') return;
    const content = await readProjectFile(project.root, file.path);
    setProject((previous) => ({ ...previous, selectedFile: file.path, selectedContent: content }));
  };

  const handleRun = async () => {
    if (!window.codDesktop) {
      setTerminalOutput(`$ ${command}\n✓ 18 tests passed\n✓ typecheck passed\n预览模式，没有执行本机命令`);
      return;
    }
    setTerminalOutput(`$ ${command}\n执行中...`);
    const result = await window.codDesktop.runCommand(project.root, command);
    setTerminalOutput(`$ ${result.command}\n${result.output}\nexit ${result.exitCode ?? 'unknown'}`);
  };

  return (
    <div className="app-shell">
      <aside className="rail">
        <Brand />
        <div className="rail-actions">
          <button className="icon-button active" title="任务"><ListChecks weight="fill" /></button>
          <button className="icon-button" title="普通对话" onClick={() => setMode('chat')}><ChatCircleDots /></button>
          <button className="icon-button" title="命令面板"><Command /></button>
          {products.map((product) => <button className="icon-button" title={product.name} key={product.id} onClick={() => product.embedUrl ? setActiveProduct(product) : window.open(product.launchUrl, '_blank', 'noopener,noreferrer')}><ArrowSquareOut /></button>)}
        </div>
        <div className="rail-footer">
          <button className="icon-button" title="账户"><UserCircle /></button>
        </div>
      </aside>

      <aside className="sidebar">
        <div className="sidebar-head">
          <div>
            <small>工作区</small>
            <strong>{mode === 'code' ? '代码任务' : '对话'}</strong>
          </div>
          <button className="new-task"><Plus weight="bold" /> 新任务</button>
        </div>
        <div className="search"><MagnifyingGlass /><input aria-label="搜索任务" placeholder="搜索任务或项目" /></div>
        <TaskList tasks={demoTasks} activeId={activeTask} onSelect={setActiveTask} />
        <div className="sidebar-bottom">
          <button className="project-switch" onClick={handleOpenProject}>
            <span className="project-icon"><Folder weight="fill" /></span>
            <span><small>当前项目</small><strong>{project.root.split('/').pop()}</strong></span>
            <CaretDown />
          </button>
          <div className="balance-preview"><Lightning weight="fill" /><span><small>{accountError ? '离线余额' : 'KAI Token'}</small><strong>¥ {session ? (session.account.balanceCents / 100).toFixed(2) : '68.40'}</strong></span><button onClick={handleTopup} disabled={!session}>充值</button></div>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div className="task-heading">
            <button className="mobile-only icon-button"><SidebarSimple /></button>
            <div>
              <h1>{active.title}</h1>
              <p>{project.root}</p>
            </div>
          </div>
          <div className="header-actions">
            <div className="mode-switch" aria-label="工作模式">
              <button className={mode === 'code' ? 'active' : ''} onClick={() => setMode('code')}><Code /> 代码</button>
              <button className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}><ChatCircleDots /> 对话</button>
            </div>
            <button className="model-picker" onClick={() => session && setSelectedModel(session.models[(session.models.findIndex((model) => model.id === selectedModel) + 1) % session.models.length]?.id ?? selectedModel)}><span>KAI</span> {selectedModel} <CaretDown /></button>
          </div>
        </header>

        <section className="conversation">
          <div className="conversation-scroll">
            <div className="user-message">
              <p>把桌面端改成 COD 品牌，工作台要有任务、文件、Diff 和终端，保留权限确认。</p>
            </div>
            <div className="agent-intro">
              <div className="agent-avatar"><span>C</span></div>
              <div><strong>COD Agent</strong><small>正在执行</small></div>
              <span className="live-chip"><CircleNotch className="spin" /> running</span>
            </div>
            {chatReply && <div className="agent-reply"><p>{chatReply}</p></div>}
            <div className="timeline">
              {demoTimeline.map((item, index) => (
                <article className={`timeline-item ${item.kind}`} key={item.id}>
                  <div className="timeline-line">
                    <span className="timeline-node"><StatusGlyph status={item.status ?? 'draft'} /></span>
                    {index < demoTimeline.length - 1 && <i />}
                  </div>
                  <div className="timeline-copy"><strong>{item.title}</strong><p>{item.detail}</p></div>
                  {item.kind === 'permission' && (
                    <div className="permission-actions">
                      <button className="approve" onClick={() => setTerminalOutput('$ npm test\n权限已批准，等待执行')}>允许一次</button>
                      <button>拒绝</button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </div>
          <div className="composer-wrap">
            <div className="context-strip">
              <span><Folder weight="fill" /> {project.root.split('/').pop()}</span>
              <span><GitDiff /> 4 个改动</span>
              <span><ShieldCheck /> 受控模式</span>
              <button onClick={handleKnowledge}><MagnifyingGlass /> 公司 Wiki</button>
              <button onClick={handleRemoteTask}><PaperPlaneTilt /> 发送到设备</button>
            </div>
            {remoteNotice && <div className="remote-notice">{remoteNotice}</div>}
            {knowledgeHits.length > 0 && <div className="knowledge-strip">{knowledgeHits.map((hit) => <a href={hit.url} target="_blank" rel="noreferrer" key={hit.id}><strong>{hit.title}</strong><span>{hit.excerpt}</span></a>)}</div>}
            <div className="composer">
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={mode === 'code' ? '让 COD 修改、检查或解释这个项目...' : '问 COD 任何问题...'} />
              <div className="composer-footer"><button className="composer-tool"><Plus /></button><span>⌘ ↵ 发送</span><button className="send" disabled={!prompt.trim() || !session || isSending} onClick={handleSend}>{isSending ? <CircleNotch className="spin" /> : <PaperPlaneTilt weight="fill" />}</button></div>
            </div>
          </div>
        </section>
      </main>

      <aside className="inspector">
        <div className="inspector-tabs">
          <button className={inspectorTab === 'changes' ? 'active' : ''} onClick={() => setInspectorTab('changes')}><GitDiff /> 改动</button>
          <button className={inspectorTab === 'files' ? 'active' : ''} onClick={() => setInspectorTab('files')}><Folder /> 文件</button>
          <button className={inspectorTab === 'terminal' ? 'active' : ''} onClick={() => setInspectorTab('terminal')}><TerminalWindow /> 终端</button>
        </div>
        <div className="inspector-body">
          {inspectorTab === 'changes' && <><div className="panel-title"><span><GitDiff /> 未提交改动</span><button title="刷新"><ArrowsClockwise /></button></div><CodeBlock text={project.diff || '当前项目没有未提交改动。'} /></>}
          {inspectorTab === 'files' && <><div className="panel-title"><span><Folder /> 项目文件</span><small>{project.files.length}</small></div><FileTree files={project.files} selected={project.selectedFile} onSelect={handleFileSelect} />{project.selectedFile && <div className="file-preview"><strong>{project.selectedFile}</strong><CodeBlock text={project.selectedContent} /></div>}</>}
          {inspectorTab === 'terminal' && <><div className="panel-title"><span><TerminalWindow /> 本地终端</span><small>{hasDesktopBridge() ? 'desktop' : 'preview'}</small></div><div className="terminal"><pre>{terminalOutput}</pre><div className="terminal-command"><span>$</span><input aria-label="终端命令" value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && handleRun()} /><button onClick={handleRun}>运行</button></div></div></>}
        </div>
      </aside>
      {activeProduct?.embedUrl && (
        <section className="product-overlay" aria-label={`${activeProduct.name} 产品`}>
          <header><strong>{activeProduct.name}</strong><div><button onClick={() => window.open(activeProduct.launchUrl, '_blank', 'noopener,noreferrer')}><ArrowSquareOut /> 浏览器打开</button><button onClick={() => setActiveProduct(null)}>关闭</button></div></header>
          <iframe title={activeProduct.name} src={activeProduct.embedUrl} sandbox="allow-forms allow-popups allow-scripts allow-same-origin" referrerPolicy="strict-origin-when-cross-origin" />
        </section>
      )}
    </div>
  );
}
