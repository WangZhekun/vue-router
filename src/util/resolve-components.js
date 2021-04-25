/* @flow */

import { _Vue } from '../install'
import { warn } from './warn'
import { isError } from '../util/errors'

/**
 * 返回钩子函数，该钩子函数是执行异步组件工厂函数获取组件配置对象
 * @param {Array<RouteRecord>} matched 新路由的匹配列表剩余路由
 * @returns 
 */
export function resolveAsyncComponents (matched: Array<RouteRecord>): Function {
  return (to, from, next) => {
    let hasAsync = false
    let pending = 0 // matched中异步组件的计数器，确保所有异步组件工厂函数都执行完
    let error = null

    // 对matched中所有涉及的组件，如果是异步组件，则执行其工厂方法，获取组件配置对象
    flatMapComponents(matched, (def, _, match, key) => { // def为Vue组件，_为Vue实例，match为路由记录，key为Vue组件在match.components中的属性名
      // if it's a function and doesn't have cid attached,
      // assume it's an async component resolve function.
      // we are not using Vue's default async resolving mechanism because
      // we want to halt the navigation until the incoming component has been
      // resolved.
      if (typeof def === 'function' && def.cid === undefined) { // 异步组件
        hasAsync = true
        pending++

        const resolve = once(resolvedDef => {
          if (isESModule(resolvedDef)) {
            resolvedDef = resolvedDef.default
          }
          // save resolved on async factory in case it's used elsewhere
          def.resolved = typeof resolvedDef === 'function'
            ? resolvedDef
            : _Vue.extend(resolvedDef)
          match.components[key] = resolvedDef // 组件配置对象
          pending--
          if (pending <= 0) {
            next()
          }
        })

        const reject = once(reason => {
          const msg = `Failed to resolve async component ${key}: ${reason}`
          process.env.NODE_ENV !== 'production' && warn(false, msg)
          if (!error) {
            error = isError(reason)
              ? reason
              : new Error(msg)
            next(error)
          }
        })

        let res
        try {
          res = def(resolve, reject) // 执行异步组件工厂函数
        } catch (e) {
          reject(e)
        }
        if (res) {
          if (typeof res.then === 'function') {
            res.then(resolve, reject)
          } else {
            // new syntax in Vue 2.3
            const comp = res.component
            if (comp && typeof comp.then === 'function') {
              comp.then(resolve, reject)
            }
          }
        }
      }
    })

    if (!hasAsync) next()
  }
}

/**
 * 对matched中的所有路由记录涉及的组件，都执行fn方法
 * @param {Array<RouteRecord} matched 路由记录
 * @param {Function} fn 每一个路由记录的组件列表的元素的处理函数，返回一个函数或数组
 * @returns 
 */
export function flatMapComponents (
  matched: Array<RouteRecord>,
  fn: Function
): Array<?Function> {
  // 返回[[], functon, function, [], functon, function]，所有路由记录的组件的钩子函数列表
  return flatten(matched.map(m => { // flatten入参为[[[], functon, function], [[], functon, function]]
    // 返回[[], functon, function]，数组元素为每一个组件的钩子或钩子列表
    return Object.keys(m.components).map(key => fn(
      m.components[key],
      m.instances[key],
      m, key
    ))
  }))
}

// 合并arr的元素为一个数组
export function flatten (arr: Array<any>): Array<any> {
  return Array.prototype.concat.apply([], arr)
}

const hasSymbol =
  typeof Symbol === 'function' &&
  typeof Symbol.toStringTag === 'symbol'

function isESModule (obj) {
  return obj.__esModule || (hasSymbol && obj[Symbol.toStringTag] === 'Module')
}

// in Webpack 2, require.ensure now also returns a Promise
// so the resolve/reject functions may get called an extra time
// if the user uses an arrow function shorthand that happens to
// return that Promise.
function once (fn) {
  let called = false
  return function (...args) {
    if (called) return
    called = true
    return fn.apply(this, args)
  }
}
