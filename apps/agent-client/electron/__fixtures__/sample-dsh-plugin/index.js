/**
 * 本地验证用 fixture DSH 插件：仅依赖桥接服务 ctx.toast / ctx.set，
 * 证明 Cordis 宿主能真正执行 apply(ctx) 并调用本客户端提供的桥接能力。
 * 不依赖任何完整 DSH host 服务。
 */
export default {
  name: 'sample-dsh-plugin',
  apply(ctx) {
    ctx.toast.success('sample-dsh-plugin 已激活');
    ctx.set('sampleValue', 42);
  },
};
