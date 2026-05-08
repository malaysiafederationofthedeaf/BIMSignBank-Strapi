export default (config, { strapi }) => {
  return async (ctx, next) => {
    const protectedPath = ctx.path.startsWith('/api/');
    if (protectedPath) {
      const token = ctx.headers['x-internal-token'];
      const expected = strapi.config.get('server.internalToken');

      if (!expected) {
        strapi.log.error('INTERNAL_TOKEN configuration is not set');
        ctx.status = 500;
        ctx.body = { error: 'Server configuration error' };
        return;
      }

      if (!token || token !== expected) {
        ctx.status = 403;
        ctx.body = { error: 'Forbidden' };
        return;
      }
    }

    await next();
  };
};