import { validationError } from '../utils/errors.js';

/** validate({ params, query, body }) → parsed values are placed on req.valid (req.query is read-only in Express 5). */
export const validate = (schemas) => (req, _res, next) => {
  const valid = {};
  const issues = [];
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const result = schemas[part].safeParse(req[part] ?? {});
    if (result.success) valid[part] = result.data;
    else issues.push(...result.error.issues.map((i) => ({ location: part, path: i.path.join('.'), message: i.message })));
  }
  if (issues.length) throw validationError(issues);
  req.valid = valid;
  next();
};
