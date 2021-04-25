/* @flow */

import { _Vue } from '../install'
import type Router from '../index'
import { inBrowser } from '../util/dom'
import { runQueue } from '../util/async'
import { warn } from '../util/warn'
import { START, isSameRoute, handleRouteEntered } from '../util/route'
import {
  flatten,
  flatMapComponents,
  resolveAsyncComponents
} from '../util/resolve-components'
import {
  createNavigationDuplicatedError,
  createNavigationCancelledError,
  createNavigationRedirectedError,
  createNavigationAbortedError,
  isError,
  isNavigationFailure,
  NavigationFailureType
} from '../util/errors'

export class History {
  router: Router
  base: string // 基础路径
  current: Route // 当前路由
  pending: ?Route // 跳转中的目标路由
  cb: (r: Route) => void // 当前路由更新时的回调
  ready: boolean // 跳转完成
  readyCbs: Array<Function> // 跳转完成的回调
  readyErrorCbs: Array<Function> // 跳转错误回调
  errorCbs: Array<Function> // 错误回调
  listeners: Array<Function> // 注销回调
  cleanupListeners: Function

  // implemented by sub-classes
  +go: (n: number) => void
  +push: (loc: RawLocation, onComplete?: Function, onAbort?: Function) => void
  +replace: (
    loc: RawLocation,
    onComplete?: Function,
    onAbort?: Function
  ) => void
  +ensureURL: (push?: boolean) => void
  +getCurrentLocation: () => string
  +setupListeners: Function

  constructor (router: Router, base: ?string) {
    this.router = router
    this.base = normalizeBase(base)
    // start with a route object that stands for "nowhere"
    this.current = START 
    this.pending = null
    this.ready = false
    this.readyCbs = []
    this.readyErrorCbs = []
    this.errorCbs = []
    this.listeners = []
  }

  // 添加更新当前路由时的回调
  listen (cb: Function) {
    this.cb = cb
  }

  onReady (cb: Function, errorCb: ?Function) {
    if (this.ready) {
      cb()
    } else {
      this.readyCbs.push(cb)
      if (errorCb) {
        this.readyErrorCbs.push(errorCb)
      }
    }
  }

  onError (errorCb: Function) {
    this.errorCbs.push(errorCb)
  }

  // 路由跳转
  transitionTo (
    location: RawLocation, // 目标地址
    onComplete?: Function, // 完毕回调
    onAbort?: Function // 错误回调
  ) {
    let route
    // catch redirect option https://github.com/vuejs/vue-router/issues/3201
    try {
      route = this.router.match(location, this.current) // 匹配路由
    } catch (e) {
      this.errorCbs.forEach(cb => {
        cb(e)
      })
      // Exception should still be thrown
      throw e
    }
    const prev = this.current
    this.confirmTransition(
      route, // 目标路由
      () => { // 完毕回调
        this.updateRoute(route) // 更新当前路由
        onComplete && onComplete(route) // 执行完毕回调
        this.ensureURL() // 更新浏览器地址
        this.router.afterHooks.forEach(hook => { // 执行Router的钩子
          hook && hook(route, prev)
        })

        // fire ready cbs once 置就绪状态
        if (!this.ready) {
          this.ready = true
          this.readyCbs.forEach(cb => {
            cb(route)
          })
        }
      },
      err => { // 错误回调
        if (onAbort) { // 执行错误回调
          onAbort(err)
        }
        if (err && !this.ready) { // 置就绪状态
          // Initial redirection should not mark the history as ready yet
          // because it's triggered by the redirection instead
          // https://github.com/vuejs/vue-router/issues/3225
          // https://github.com/vuejs/vue-router/issues/3331
          if (!isNavigationFailure(err, NavigationFailureType.redirected) || prev !== START) {
            this.ready = true
            this.readyErrorCbs.forEach(cb => {
              cb(err)
            })
          }
        }
      }
    )
  }

  // 路由跳转
  confirmTransition (route: Route, onComplete: Function, onAbort?: Function) {
    const current = this.current
    this.pending = route
    const abort = err => {
      // changed after adding errors with
      // https://github.com/vuejs/vue-router/pull/3047 before that change,
      // redirect and aborted navigation would produce an err == null
      if (!isNavigationFailure(err) && isError(err)) {
        if (this.errorCbs.length) {
          this.errorCbs.forEach(cb => {
            cb(err)
          })
        } else {
          warn(false, 'uncaught error during route navigation:')
          console.error(err)
        }
      }
      onAbort && onAbort(err)
    }
    const lastRouteIndex = route.matched.length - 1
    const lastCurrentIndex = current.matched.lengt·h - 1
    if (
      isSameRoute(route, current) && // 目标路由与当前路由是同一个路由，参数等都相同
      // in the case the route map has been dynamically appended to
      lastRouteIndex === lastCurrentIndex && // 匹配路由列表长度相同
      route.matched[lastRouteIndex] === current.matched[lastCurrentIndex] // 匹配路由列表的最后一个路由相同
    ) {
      this.ensureURL() // 更新浏览器地址
      return abort(createNavigationDuplicatedError(current, route)) // 执行错误回调
    }

    const { 
      updated, // 匹配列表的相同路由
      deactivated, // 当前路由的匹配列表剩余路由
      activated // 新路由的匹配列表剩余路由
    } = resolveQueue(
      this.current.matched,
      route.matched
    )

    const queue: Array<?NavigationGuard> = [].concat( // 合并钩子函数列表
      // in-component leave guards
      extractLeaveGuards(deactivated), // 老路由涉及的组件的beforeRouteLeave钩子函数
      // global before hooks
      this.router.beforeHooks, // router的before钩子函数
      // in-component update hooks
      extractUpdateHooks(updated), // 相同路由涉及的组件的beforeRouteUpdate钩子函数
      // in-config enter guards
      activated.map(m => m.beforeEnter), // 新路由涉及的组件的beforeEnter钩子函数
      // async components
      resolveAsyncComponents(activated) // 返回钩子函数，该钩子函数是执行异步组件工厂函数获取组件配置对象
    )

    const iterator = (hook: NavigationGuard, next) => {
      if (this.pending !== route) {
        return abort(createNavigationCancelledError(current, route))
      }
      try {
        // 执行钩子
        hook(route, current, (to: any) => {
          if (to === false) {
            // next(false) -> abort navigation, ensure current URL
            this.ensureURL(true)
            abort(createNavigationAbortedError(current, route))
          } else if (isError(to)) {
            this.ensureURL(true)
            abort(to)
          } else if (
            typeof to === 'string' ||
            (typeof to === 'object' &&
              (typeof to.path === 'string' || typeof to.name === 'string'))
          ) { // 重定向
            // next('/') or next({ path: '/' }) -> redirect
            abort(createNavigationRedirectedError(current, route))
            if (typeof to === 'object' && to.replace) {
              this.replace(to)
            } else {
              this.push(to)
            }
          } else {
            // confirm transition and pass on the value
            next(to)
          }
        })
      } catch (e) {
        abort(e)
      }
    }

    runQueue(queue, iterator, () => {
      // wait until async components are resolved before
      // extracting in-component enter guards
      const enterGuards = extractEnterGuards(activated) // 新路由剩余路由涉及的组件的beforeRouteEnter钩子函数
      const queue = enterGuards.concat(this.router.resolveHooks) // 同beforeResolve钩子执行队列做合并
      // 执行钩子函数队列
      runQueue(queue, iterator, () => {
        if (this.pending !== route) {
          return abort(createNavigationCancelledError(current, route))
        }
        this.pending = null
        onComplete(route) // 跳转完成
        if (this.router.app) {
          this.router.app.$nextTick(() => {
            handleRouteEntered(route)
          })
        }
      })
    })
  }

  // 更新当前路由
  updateRoute (route: Route) {
    this.current = route
    this.cb && this.cb(route)
  }

  setupListeners () {
    // Default implementation is empty
  }

  // 执行注销回调列表内的函数
  teardown () {
    // clean up event listeners
    // https://github.com/vuejs/vue-router/issues/2341
    this.listeners.forEach(cleanupListener => {
      cleanupListener()
    })
    this.listeners = []

    // reset current history route
    // https://github.com/vuejs/vue-router/issues/3294
    this.current = START
    this.pending = null
  }
}

function normalizeBase (base: ?string): string {
  if (!base) {
    if (inBrowser) {
      // respect <base> tag
      const baseEl = document.querySelector('base')
      base = (baseEl && baseEl.getAttribute('href')) || '/'
      // strip full URL origin
      base = base.replace(/^https?:\/\/[^\/]+/, '')
    } else {
      base = '/'
    }
  }
  // make sure there's the starting slash
  if (base.charAt(0) !== '/') {
    base = '/' + base
  }
  // remove trailing slash
  return base.replace(/\/$/, '')
}

function resolveQueue (
  current: Array<RouteRecord>,
  next: Array<RouteRecord>
): {
  updated: Array<RouteRecord>,
  activated: Array<RouteRecord>,
  deactivated: Array<RouteRecord>
} {
  let i
  const max = Math.max(current.length, next.length)
  for (i = 0; i < max; i++) {
    if (current[i] !== next[i]) {
      break
    }
  }
  return {
    updated: next.slice(0, i), // 匹配列表的相同路由
    activated: next.slice(i), // 新路由的匹配列表剩余路由
    deactivated: current.slice(i) // 当前路由的匹配列表剩余路由
  }
}

/**
 * 获取路由记录的所有组件的所有name的钩子函数
 * @param {Array<RouteRecord>} records 路由记录
 * @param {string} name 钩子名称
 * @param {Function} bind 绑定函数
 * @param {boolean} reverse 是否反转
 * @returns 
 */
function extractGuards (
  records: Array<RouteRecord>, // 路由记录
  name: string, // 钩子名称
  bind: Function, // 绑定函数
  reverse?: boolean // 是否反转钩子的执行顺序
): Array<?Function> {
  // 获取路由记录的所有组件的所有name的钩子函数
  const guards = flatMapComponents(records, (def, instance, match, key) => { // def为Vue组件，instance为Vue实例，match为路由记录，key为Vue组件在match.components中的属性名
    const guard = extractGuard(def, name) // 返回Vue组件的钩子的方法
    if (guard) {
      return Array.isArray(guard)
        ? guard.map(guard => bind(guard, instance, match, key))
        : bind(guard, instance, match, key) // 将钩子的方法绑定到Vue实例上
    }
  })
  return flatten(reverse ? guards.reverse() : guards) // 合并钩子函数为一个数组
}

// 返回def（Vue组件）的key属性的值
function extractGuard (
  def: Object | Function,
  key: string
): NavigationGuard | Array<NavigationGuard> {
  if (typeof def !== 'function') {
    // extend now so that global mixins are applied.
    def = _Vue.extend(def)
  }
  return def.options[key] 
}

/**
 * 获取deactivated路由记录中所有组件的所有beforeRouteLeave钩子的执行函数
 * @param {Array<RouteRecord} deactivated 老路由匹配列表中需要调用beforeRouteLeave钩子的路由记录
 * @returns 
 */
function extractLeaveGuards (deactivated: Array<RouteRecord>): Array<?Function> {
  return extractGuards(deactivated, 'beforeRouteLeave', bindGuard, true)
}

// 获取updated路由记录中所有组件的所有beforeRouteUpdate钩子的执行函数
function extractUpdateHooks (updated: Array<RouteRecord>): Array<?Function> {
  return extractGuards(updated, 'beforeRouteUpdate', bindGuard)
}

/**
 * 返回一个可以执行guard的函数，并将guard的this，绑定到instance
 * @param {NavigationGuard} guard 待执行函数
 * @param {_Vue} instance Vue实例
 * @returns 
 */
function bindGuard (guard: NavigationGuard, instance: ?_Vue): ?NavigationGuard {
  if (instance) {
    return function boundRouteGuard () {
      return guard.apply(instance, arguments)
    }
  }
}

/**
 * 获取activated路由记录中所有组件的所有beforeRouteEnter钩子的执行函数
 * @param {Array<RouteRecord>} activated 新路由的匹配列表剩余路由
 * @returns 
 */
function extractEnterGuards (
  activated: Array<RouteRecord>
): Array<?Function> {
  return extractGuards(
    activated,
    'beforeRouteEnter',
    (guard, _, match, key) => {
      return bindEnterGuard(guard, match, key)
    }
  )
}

/**
 * 返回guard的执行器，收集由guard第三个参数返回的回调函数
 * @param {NavigationGuard} guard 待执行函数
 * @param {RouteRecord} match 路由记录 
 * @param {string} key 
 * @returns 
 */
function bindEnterGuard (
  guard: NavigationGuard,
  match: RouteRecord,
  key: string
): NavigationGuard {
  return function routeEnterGuard (to, from, next) {
    // 执行钩子函数，将回调函数插入到进入路由之后的回调队列
    return guard(to, from, cb => {
      if (typeof cb === 'function') {
        if (!match.enteredCbs[key]) {
          match.enteredCbs[key] = []
        }
        match.enteredCbs[key].push(cb)
      }
      next(cb)
    })
  }
}
