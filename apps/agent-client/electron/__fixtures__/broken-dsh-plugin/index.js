/**
 * 本地验证用 fixture：apply 故意抛错，验证 Cordis 宿主能优雅捕获错误
 * 并写入 record.error，而不是让进程崩溃。
 */
export default {
  name: 'broken-dsh-plugin',
  apply() {
    throw new Error('boom: 模拟插件初始化失败');
  },
};
