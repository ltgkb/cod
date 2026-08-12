import { ApiError } from './api';

export function chatFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'insufficient_balance') {
    return 'COD 可用额度不足，最后一次失败请求未扣费；此前已成功的模型调用仍按实际用量结算。请充值或购买额度包后重试。';
  }
  const message = error instanceof Error ? error.message : '';
  if (/please check your account with your provider to add more credits|insufficient balance/i.test(message)) {
    return 'COD 可用额度不足，最后一次失败请求未扣费；此前已成功的模型调用仍按实际用量结算。请充值或购买额度包后重试。';
  }
  if (error instanceof ApiError && error.code === 'ai_upstream_auth_failed') {
    return '模型服务认证配置异常，本次失败未扣费。请切换其他模型或稍后再试。';
  }
  if (error instanceof ApiError && error.status === 429) return '模型请求较多，自动重试后仍未成功。请稍后再次发送。';
  if (error instanceof ApiError && error.code === 'incomplete_model_response') return '模型及备用模型都达到了输出上限，系统未保存半截回答且本次未扣费。请缩小任务范围后重试。';
  if (error instanceof ApiError && (error.status === 504 || error.code === 'ai_upstream_timeout')) return '模型生成超时，系统已自动重试且本次未扣费。请重试、缩短任务，或切换其他模型。';
  if (error instanceof ApiError && error.status >= 500) return '模型服务暂时波动，系统已自动重试但尚未恢复。你可以点击下方按钮继续重试，本次失败不会扣费。';
  return message || 'COD 执行失败，本次失败不会扣费。';
}
