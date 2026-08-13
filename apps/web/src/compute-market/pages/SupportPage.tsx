import { ChatCircleDots, ShieldCheck } from '@phosphor-icons/react';

export function SupportPage({ onOpenCodTask }: { onOpenCodTask?: (input: { title: string; prompt: string }) => void }) {
  return <div className="compute-page-stack"><section className="compute-support-hero"><ChatCircleDots weight="duotone" /><h2>算力服务支持</h2><p>订单、托管和设备问题会作为 COD 任务进入工作区，保留上下文与处理记录。</p><button type="button" className="compute-button primary" disabled={!onOpenCodTask} onClick={() => onOpenCodTask?.({ title: '算力市场服务支持', prompt: '请协助处理我的算力市场订单、托管申请或设备问题。请先向我确认相关订单/申请/设备编号，不要索取密码或私钥。' })}>{onOpenCodTask ? '创建支持任务' : '当前平台未接入任务创建'}</button></section><section className="compute-panel"><h2><ShieldCheck /> 安全提示</h2><p>支持人员不会要求你在聊天中发送 SSH 私钥、口令、完整身份证件或合同原件。交付凭据仅通过短期一次性领取流程提供。</p></section></div>;
}
