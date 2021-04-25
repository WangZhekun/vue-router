import View from './components/view'
import Link from './components/link'

export let _Vue

export function install (Vue) {
  if (install.installed && _Vue === Vue) return
  install.installed = true

  _Vue = Vue

  const isDef = v => v !== undefined

  const registerInstance = (vm, callVal) => {
    let i = vm.$options._parentVnode
    if (isDef(i) && isDef(i = i.data) && isDef(i = i.registerRouteInstance)) { // registerRouteInstance方法在components的view.js中添加 TODO 作用不清晰
      i(vm, callVal)
    }
  }

  Vue.mixin({ // 给Vue混入beforeCreate和destroyed钩子
    beforeCreate () {
      if (isDef(this.$options.router)) { // 当前Vue实例是根实例
        this._routerRoot = this // _routerRoot指向Vue根实例
        this._router = this.$options.router // _router指向根实例上的router实例
        this._router.init(this) // 执行router实例的init方法
        Vue.util.defineReactive(this, '_route', this._router.history.current) // 给Vue根实例创建一个响应式的_route属性，值为当前路由对象
      } else {
        this._routerRoot = (this.$parent && this.$parent._routerRoot) || this // 给非根Vue实例，添加_routerRoot属性，指向父实例的_routerRoot属性（一般为根实例），无$parent的，指向自身
      }
      registerInstance(this, this)
    },
    destroyed () {
      registerInstance(this)
    }
  })

  Object.defineProperty(Vue.prototype, '$router', { // 给Vue原型对象，定义`$router`属性，指向根Vue实例的router实例 TODO 对于上述beforeCreate钩子中的无$parent的情况呢
    get () { return this._routerRoot._router }
  })

  Object.defineProperty(Vue.prototype, '$route', { // 给Vue原型对象，定义`$route`属性，指向根Vue实例的_route属性，值为当前匹配的Route实例
    get () { return this._routerRoot._route }
  })

  Vue.component('RouterView', View) // 注册RouterView组件
  Vue.component('RouterLink', Link) // 注册RouterLink组件

  const strats = Vue.config.optionMergeStrategies // 给beforeRouteEnter、beforeRouteLeave、beforeRouteUpdate钩子添加合并策略，同Vue的created钩子
  // use the same hook merging strategy for route hooks
  strats.beforeRouteEnter = strats.beforeRouteLeave = strats.beforeRouteUpdate = strats.created
}
