import { fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server'

export type Schema = { static: unknown }

export type StaticOf<S extends Schema> = S['static']

export const toolInput = <S extends Schema>(schema: S) => fromJsonSchema<StaticOf<S>>(schema as unknown as JsonSchemaType)
