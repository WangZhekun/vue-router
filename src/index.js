/* @flow */

import { install } from './install'
import { START } from './util/route'
import { assert, warn } from './util/warn'
import { inBrowser } from './util/dom'
import { cleanPath } from './util/path'
import { createMatcher } from './create-matcher'
import { normalizeLocation } from './util/location'
import { supportsPushState } from './util/push-state'
import { handleScroll } from './util/scroll'

import { HashHistory } from './history/hash'
import { HTML5History } from './history/html5'
import { AbstractHistory } from './history/abstract'

import type { Matcher } from './create-matcher'

import { isNavigationFailure, NavigationFailureType } from './util/errors'

export default class VueRouter {
  static install: () => void
  static version: string
  static isNavigationFailure: Function
  static NavigationFailureType: any
  static START_LOCATION: Route

  app: any // 主Vue实例
  apps: Array<any> // 依赖当前Router实例的Vue实例列表
  ready: boolean
  readyCbs: Array<Function>
  options: RouterOptions
  mode: string // 路由模式
  history: HashHistory | HTML5History | AbstractHistory // 路由历史
  matcher: Matcher // 匹配对象，包含match和addRoutes API
  fallback: boolean
  beforeHooks: Array<?NavigationGuard> // beforeEach钩子执行队列
  resolveHooks: Array<?NavigationGuard> // beforeResolve钩子执行队列
  afterHooks: Array<?AfterNavigationHook> // afterEach钩子执行队列

  constructor (options: RouterOptions = {}) {
    this.app = null
    this.apps = []
    this.options = options
    this.beforeHooks = []
    this.resolveHooks = []
    this.afterHooks = []
    this.matcher = createMatcher(options.routes || [], this)

    let mode = options.mode || 'hash'
    this.fallback =
      mode === 'history' && !supportsPushState && options.fallback !== false
    if (this.fallback) {
      mode = 'hash'
    }
    if (!inBrowser) {
      mode = 'abstract'
    }
    this.mode = mode

    switch (mode) {
      case 'history':
        this.history = new HTML5History(this, options.base)
        break
      case 'hash':
        this.history = new HashHistory(this, options.base, this.fallback)
        break
      case 'abstract':
        this.history = new AbstractHistory(this, options.base)
        break
      default:
        if (process.env.NODE_ENV !== 'production') {
          assert(false, `invalid mode: ${mode}`)
        }
    }
  }

  // 匹配raw对应的路由
  match (raw: RawLocation, current?: Route, redirectedFrom?: Location): Route {
    return this.matcher.match(raw, current, redirectedFrom)
  }

  // 获取当前路由
  get currentRoute (): ?Route {
    return this.history && this.history.current
  }

  // Router实例初始化
  init (app: any /* Vue component instance */) {
    process.env.NODE_ENV !== 'production' &&
      assert(
        install.installed,
        `not installed. Make sure to call \`Vue.use(VueRouter)\` ` +
          `before creating root instance.`
      )

    this.apps.push(app) // 维护依赖当前Router实例的Vue实例

    // set up app destroyed handler
    // https://github.com/vuejs/vue-router/issues/2639
    app.$once('hook:destroyed', () => { // 定义Vue实例销毁钩子
      // clean out app from this.apps array once destroyed
      const index = this.apps.indexOf(app)
      if (index > -1) this.apps.splice(index, 1) // 从依赖当前Router实例的Vue实例列表中移除
      // ensure we still have a main app or null if no apps
      // we do not release the router so it can be reused
      if (this.app === app) this.app = this.apps[0] || null // 更新主Vue实例

      if (!this.app) this.history.teardown() // 无主Vue实例时，执行注销回调列表内的函数
    })

    // main app previously initialized
    // return as we don't need to set up new history listener
    if (this.app) { // 如果主Vue实例已存在
      return
    }

    this.app = app // 设置主Vue实例

    const history = this.history

    if (history instanceof HTML5History || history instanceof HashHistory) { // 客户端渲染
      const handleInitialScroll = routeOrError => {
        const from = history.current
        const expectScroll = this.options.scrollBehavior
        const supportsScroll = supportsPushState && expectScroll

        if (supportsScroll && 'fullPath' in routeOrError) {
          handleScroll(this, routeOrError, from, false)
        }
      }
      const setupListeners = routeOrError => {
        history.setupListeners() // 初始化注销回调列表
        handleInitialScroll(routeOrError)
      }
      history.transitionTo( // 跳转到当前地址的路由
        history.getCurrentLocation(),
        setupListeners,
        setupListeners
      )
    }

    history.listen(route => { // 注册当前路由变更后的回调
      this.apps.forEach(app => { // 更新Vue实例的_route属性，触发组件重新渲染
        app._route = route
      })
    })
  }

  // 注册beforeEach钩子
  beforeEach (fn: Function): Function {
    return registerHook(this.beforeHooks, fn)
  }

  // 注册beforeResolve钩子
  beforeResolve (fn: Function): Function {
    return registerHook(this.resolveHooks, fn)
  }

  // 注册afterEach钩子
  afterEach (fn: Function): Function {
    return registerHook(this.afterHooks, fn)
  }

  // 注册跳转完成后的回调
  onReady (cb: Function, errorCb?: Function) {
    this.history.onReady(cb, errorCb)
  }

  // 注册错误回调
  onError (errorCb: Function) {
    this.history.onError(errorCb)
  }

  // 跳转
  push (location: RawLocation, onComplete?: Function, onAbort?: Function) {
    // $flow-disable-line
    if (!onComplete && !onAbort && typeof Promise !== 'undefined') {
      return new Promise((resolve, reject) => {
        this.history.push(location, resolve, reject)
      })
    } else {
      this.history.push(location, onComplete, onAbort)
    }
  }

  // 替换
  replace (location: RawLocation, onComplete?: Function, onAbort?: Function) {
    // $flow-disable-line
    if (!onComplete && !onAbort && typeof Promise !== 'undefined') {
      return new Promise((resolve, reject) => {
        this.history.replace(location, resolve, reject)
      })
    } else {
      this.history.replace(location, onComplete, onAbort)
    }
  }

  go (n: number) {
    this.history.go(n)
  }

  back () {
    this.go(-1)
  }

  forward () {
    this.go(1)
  }

  // 获取匹配的组件
  getMatchedComponents (to?: RawLocation | Route): Array<any> {
    const route: any = to
      ? to.matched
        ? to
        : this.resolve(to).route
      : this.currentRoute
    if (!route) {
      return []
    }
    return [].concat.apply( // 合并各个匹配的路由的组件列表
      [],
      route.matched.map(m => {
        return Object.keys(m.components).map(key => {
          return m.components[key]
        })
      })
    )
  }

  // 解析目标位置
  resolve (
    to: RawLocation,
    current?: Route,
    append?: boolean
  ): {
    location: Location,
    route: Route,
    href: string,
    // for backwards compat
    normalizedTo: Location,
    resolved: Route
  } {
    current = current || this.history.current // 当前路由
    const location = normalizeLocation(to, current, append, this) // 处理目标位置
    const route = this.match(location, current) // 匹配路由
    const fullPath = route.redirectedFrom || route.fullPath // 路由的完整路径
    const base = this.history.base
    const href = createHref(base, fullPath, this.mode) // 创建url
    return {
      location,
      route,
      href,
      // for backwards compat
      normalizedTo: location,
      resolved: route
    }
  }

  getRoutes () {
    return this.matcher.getRoutes()
  }

  addRoute (parentOrRoute: string | RouteConfig, route?: RouteConfig) {
    this.matcher.addRoute(parentOrRoute, route)
    if (this.history.current !== START) {
      this.history.transitionTo(this.history.getCurrentLocation())
    }
  }

  // 添加路由，并跳转到当前地址
  addRoutes (routes: Array<RouteConfig>) {
    if (process.env.NODE_ENV !== 'production') {
      warn(false, 'router.addRoutes() is deprecated and has been removed in Vue Router 4. Use router.addRoute() instead.')
    }
    this.matcher.addRoutes(routes)
    if (this.history.current !== START) {
      this.history.transitionTo(this.history.getCurrentLocation())
    }
  }
}

function registerHook (list: Array<any>, fn: Function): Function {
  list.push(fn)
  return () => {
    const i = list.indexOf(fn)
    if (i > -1) list.splice(i, 1)
  }
}

function createHref (base: string, fullPath: string, mode) {
  var path = mode === 'hash' ? '#' + fullPath : fullPath
  return base ? cleanPath(base + '/' + path) : path
}

VueRouter.install = install
VueRouter.version = '__VERSION__'
VueRouter.isNavigationFailure = isNavigationFailure
VueRouter.NavigationFailureType = NavigationFailureType
VueRouter.START_LOCATION = START

if (inBrowser && window.Vue) {
  window.Vue.use(VueRouter)
}
