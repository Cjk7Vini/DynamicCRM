import Joi from 'joi';

export const leadSchema = Joi.object({
  fullName: Joi.string().min(2).max(200).required(),
  email: Joi.string().email().max(320).required(),
  phone: Joi.string().max(50).allow('', null),
  notes: Joi.string().max(2000).allow('', null),
  consent: Joi.boolean().truthy(1, '1', 'true', 'on').falsy(0, '0', 'false').default(true),
  source: Joi.string().max(100).default('video-click')
});
