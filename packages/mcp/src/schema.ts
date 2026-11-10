import { fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server'
import { Ajv, AjvJsonSchemaValidator, addFormats } from '@modelcontextprotocol/server/validators/ajv'

const engine = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true, logger: false })
addFormats(engine)

const validator = new AjvJsonSchemaValidator(engine)

export const jsonSchema = (schema: JsonSchemaType) => fromJsonSchema<Record<string, unknown>>(schema, validator)
