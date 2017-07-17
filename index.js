#!/usr/bin/env node

const transformer = require('postman-collection-transformer')
const { Readable: InputStream } = require('stream')
const { spawn } = require('child_process')
const drafter = require('drafter')
const uuid = require('uuid/v4')
const hash = require('sha1')
const fs = require('fs')

function blueprintToAst (blueprint) {
  return new Promise((resolve, reject) => {
    drafter.parse(blueprint, { requireBlueprintName: true, type: 'ast' }, (error, result) => {
      if (error) return reject(error)

      resolve(result.ast)
    })
  })
}

function parseAction (group, action, auth) {
  const raw = `${group.uriTemplate}${action.attributes.uriTemplate}`
              .replace(/^\/|\/$/g, '')
              .replace(/\{([^}]+)\}/g, (_, m) => `:${m}`)
  const path = raw.split('?', 2)[0].split('/')
  const query = (raw.split('?', 2)[1] || '').split('&').map(q => {
    const [key, value] = q.split('=', 2)

    return { key, value }
  }).filter(q => q.key.length)
  const parameters = [].concat(group.parameters).concat(action.parameters) 
  
  const variable = path.filter(p => /^:/.test(p))
                       .map(v => {
                         const key = v.substr(1)
                         const param = parameters.find(p => p.name === key)

                         return { key, value: param ? param.example : '', description: param.description.trim(), type: param.type }
                       })
  const url = {
    raw: `{{HOST}}/${raw}`,
    host: ['{{HOST}}'],
    path,
    query,
    variable
  }

  const req = action.examples[0].requests[0]
  const res = action.examples[0].responses[0]
  const headers = req.headers.map(h => ({ key: h.name, value: h.value }))
  if (!headers.find(h => h.key === 'Accept')) {
    const header = res.headers.find(h => h.name === 'Content-Type')

    header && headers.push({ key: 'Accept', value: header.value })
  }
  const body = {}
  if (typeof (req.body) === 'string' && req.body !== '') {
    body.mode = 'raw'
    body.raw = req.body.trim()
  }
  const request = {
    url,
    auth,
    method: action.method,
    headers,
    body,
    description: action.description
  }
  
  return {
    name: action.name,
    description: action.description,
    request
  }
}

function astToCollection (ast) {
  const info = {
    name: ast.name,
    description: ast.description,
    _postman_id: uuid(),
    schema: "https://schema.getpostman.com/json/collection/v2.0.0/collection.json"
  }

  const meta = {}
  ast.metadata.forEach(t => {
    const key = t.name.split('.')
    let target = meta

    key.forEach((k, i) => {
      if (!(k in target)) {
        target[k] = {}
      }

      if (i === key.length - 1) {
        target[k] = t.value
      } else {
        target = target[k]
      }
    })
  })
  const variables = Object.keys(meta)
    .filter(key => ['FORMAT', 'AUTH', 'ENV'].indexOf(key) < 0)
    .filter(key => ['string', 'number', 'boolean'].includes(typeof meta[key]))
    .map(key => ({ key, value: meta[key]}))
  const auth = meta.AUTH || {}

  const item = ast.resourceGroups.map(group => ({
    name: group.name,
    description: group.description,
    item: group.resources.reduce((all, resource) => {
      const i = resource.actions.map(action => parseAction(resource, action, auth))

      return all.concat(i)
    }, [])
  }))

  const environments = []

  environments.push({
    id: hash(info.name),
    name: info.name,
    timestamp: Date.now(),
    synced: false,
    values: variables.map(v => ({ name: v.key, key: v.key, value: v.value, type: 'text' }))
  })

  if (meta.ENV) {
    Object.keys(meta.ENV).forEach(env => {
      const vars = Object.keys(meta.ENV[env]).map(k => ({ key: k, value: meta.ENV[env][k] }))
      
      environments.push({
        id: hash(`${info.name} (${env})`),
        name: `${info.name} (${env})`,
        timestamp: Date.now(),
        synced: false,
        values: vars.map(v => ({ name: v.key, key: v.key, value: v.value, type: 'text' }))
      })
    })
  }

  return new Promise((resolve, reject) => {
    transformer.convert(
      { info, item },
      { inputVersion: '2.0.0', outputVersion: '1.0.0' },
      (error, result) => {
        if (error) return reject(error)
        const v1 = result
        
        resolve({
          version: 1,
          collections: [ v1 ],
          environments
        })
      })
  })
}

Promise.resolve(fs.readFileSync(process.argv[2]).toString())
  .then(blueprintToAst)
  .then(astToCollection)
  .then(collection => JSON.stringify(collection, null, 2))
  .then(content => {
    if (process.argv.length > 3) {
      fs.writeFileSync(process.argv[3], content)
    } else {
      console.log(content)
    }
  })
  .catch(e => console.error(e))
