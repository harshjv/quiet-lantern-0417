import { fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server'
import {
  addFormats,
  Ajv,
  AjvJsonSchemaValidator,
} from '@modelcontextprotocol/server/validators/ajv'

const engine = new Ajv({
  strict: false,
  validateFormats: true,
  validateSchema: false,
  allErrors: true,
  logger: false,
})
const withFormats = addFormats as (ajv: typeof engine) => typeof engine

withFormats(engine)

const validator = new AjvJsonSchemaValidator(engine)

export const jsonSchema = (schema: JsonSchemaType) =>
  fromJsonSchema<Record<string, unknown>>(schema, validator)
