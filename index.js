// the valid characters for the path component:
// [A-Za-z0-9!$%&'()*+,-.:;=@_~]
// http://stackoverflow.com/questions/4669692/valid-characters-for-directory-part-of-a-url-for-short-links
// https://tools.ietf.org/html/rfc3986#section-3.3
const wordReg = /^\w+$/
const suffixReg = /\+[A-Za-z0-9!$%&'*+,-.:;=@_~]*$/
const doubleColonReg = /^::[A-Za-z0-9!$%&'*+,-.:;=@_~]*$/
const trimSlashReg = /^\//
const fixMultiSlashReg = /\/{2,}/g

class Matched {
  constructor () {
    // Either a Node pointer when matched or nil
    this.node = null
    this.params = {}
    // If FixedPathRedirect enabled, it may returns a redirect path,
    // otherwise a empty string.
    this.fpr = ''
    // If TrailingSlashRedirect enabled, it may returns a redirect path,
    // otherwise a empty string.
    this.tsr = ''
  }
}

class Node {
  constructor (parent) {
    this.name = ''
    this.allow = ''
    this.pattern = ''
    this.segment = ''
    this.priority = 0 // For sorting varyChildren
    this.suffix = ''
    this.regex = null
    this.endpoint = false
    this.wildcard = false
    this.varyChildren = []
    this.parent = parent
    this.children = Object.create(null)
    this.handlers = Object.create(null)
  }

  handle (method, handler) {
    if (handler == null) {
      throw new TypeError('handler should not be null')
    }
    if (this.handlers[method] != null) {
      throw new Error(`"${method}" already defined`)
    }
    this.handlers[method] = handler
    if (this.allow === '') {
      this.allow = method
    } else {
      this.allow += ', ' + method
    }
  }

  getHandler (method) {
    return this.handlers[method] == null ? null : this.handlers[method]
  }

  getAllow () {
    return this.allow
  }

  getPattern () {
    return this.pattern
  }

  getSegments () {
    let segments = this.segment
    if (this.parent != null) {
      segments = this.parent.getSegments() + '/' + segments
    }
    return segments
  }
}

class Trie {
  static NAME = 'Trie'
  static VERSION = 'v3.0.0'

  constructor (options = {}) {
    this.ignoreCase = options.ignoreCase !== false
    this.fpr = options.fixedPathRedirect !== false
    this.tsr = options.trailingSlashRedirect !== false
    this.root = new Node(null)
  }

  define (pattern) {
    if (typeof pattern !== 'string') {
      throw new TypeError('Pattern must be string.')
    }
    if (pattern.includes('//')) {
      throw new Error('Multi-slash exists.')
    }

    const _pattern = pattern.replace(trimSlashReg, '')
    const node = this._defineNode(this.root, _pattern.split('/'))
    if (node.pattern === '') {
      node.pattern = pattern
    }
    return node
  }

  match (path) {
    if (typeof path !== 'string') {
      throw new TypeError('Path must be string.')
    }
    if (path === '' || path[0] !== '/') {
      throw new Error(`Path is not start with "/": "${path}"`)
    }
    let fixedLen = path.length
    if (this.fpr) {
      path = path.replace(fixMultiSlashReg, '/')
      fixedLen -= path.length
    }

    let start = 1
    let parent = this.root
    const end = path.length
    const matched = new Matched()
    for (let i = 1; i <= end; i++) {
      if (i < end && path[i] !== '/') {
        continue
      }

      let segment = path.slice(start, i)
      let node = this._matchNode(parent, segment)
      if (this.ignoreCase && node == null) {
        node = this._matchNode(parent, segment.toLowerCase())
      }
      if (node == null) {
        if (this.tsr && segment === '' && i === end && parent.endpoint) {
          matched.tsr = path.slice(0, end - 1)
          if (this.fpr && fixedLen > 0) {
            matched.fpr = matched.tsr
            matched.tsr = ''
          }
        }
        return matched
      }

      parent = node
      if (parent.name !== '') {
        if (parent.wildcard) {
          matched.params[parent.name] = path.slice(start, end)
          break
        } else {
          if (parent.suffix !== '') {
            segment = segment.slice(0, segment.length - parent.suffix.length)
          }
          matched.params[parent.name] = segment
        }
      }
      start = i + 1
    }

    if (parent.endpoint) {
      matched.node = parent
      if (this.fpr && fixedLen > 0) {
        matched.fpr = path
        matched.node = null
      }
    } else if (this.tsr && parent.children[''] != null) {
      matched.tsr = path + '/'
      if (this.fpr && fixedLen > 0) {
        matched.fpr = matched.tsr
        matched.tsr = ''
      }
    }
    return matched
  }

  remove (path) {
    if (typeof path !== 'string') {
      throw new TypeError('Path must be a string.')
    }
    if (path === '' || path[0] !== '/') {
      throw new Error(`Path must start with "/": "${path}"`)
    }

    const node = this._findNode(path)
    if (!node) {
      return
    }

    node.endpoint = false
    node.handlers = Object.create(null)
    node.allow = ''

    this._pruneNode(node)
  }

  // --- Private Methods ---

  _getSegmentKey (segment) {
    let key = segment
    if (doubleColonReg.test(key)) {
      key = key.slice(1)
    }
    if (this.ignoreCase) {
      key = key.toLowerCase()
    }
    return key
  }

  _defineNode (parent, segments) {
    const segment = segments.shift()
    const child = this._parseNode(parent, segment)
    child.segment = segment

    if (segments.length === 0) {
      child.endpoint = true
      return child
    }
    if (child.wildcard) {
      throw new Error(`Can not define pattern after wildcard: "${child.pattern}"`)
    }
    return this._defineNode(child, segments)
  }

  _matchNode (parent, segment) {
    const key = this.ignoreCase ? segment.toLowerCase() : segment;
    if (parent.children[key] != null) {
      return parent.children[key]
    }
    
    for (const child of parent.varyChildren) {
      let _segment = segment
      if (child.suffix !== '') {
        if (segment === child.suffix || !segment.endsWith(child.suffix)) {
          continue
        }
        _segment = segment.slice(0, segment.length - child.suffix.length)
      }
      if (child.regex != null && !child.regex.test(_segment)) {
        continue
      }
      return child
    }
    return null
  }

  _parseNode (parent, segment) {
    const key = this._getSegmentKey(segment)

    if (parent.children[key] != null) {
      return parent.children[key]
    }

    const node = new Node(parent)

    if (segment === '') {
        node.priority = 100 // Highest priority for trailing slash
        parent.children[''] = node
    } else if (segment[0] === ':') {
      let name = segment.slice(1)

      switch (name[name.length - 1]) {
        case '*':
          name = name.slice(0, name.length - 1)
          node.wildcard = true
          node.priority = 1
          break
        default:
          const n = name.search(suffixReg)
          if (n >= 0) {
            node.suffix = name.slice(n + 1)
            name = name.slice(0, n)
            node.priority = 4 // Higher than regex
            if (node.suffix === '') {
              throw new Error(`invalid pattern: "${node.getSegments()}"`)
            }
          }

          if (name[name.length - 1] === ')') {
            const i = name.indexOf('(')
            if (i > 0) {
              const regex = name.slice(i + 1, name.length - 1)
              if (regex.length > 0) {
                name = name.slice(0, i)
                node.regex = new RegExp(regex)
                node.priority = 3 // Higher than simple param
              } else {
                throw new Error(`Invalid pattern: "${node.getSegments()}"`)
              }
            }
          }
      }
      
      if (node.priority === 0) {
          node.priority = 2 // Simple param
      }

      if (!wordReg.test(name)) {
        throw new Error(`Invalid pattern: "${node.getSegments()}"`)
      }
      node.name = name

      for (const child of parent.varyChildren) {
         if (child.wildcard !== node.wildcard || child.suffix !== node.suffix || 
            (child.regex && node.regex && child.regex.toString() !== node.regex.toString())) {
             continue;
         }
         if (child.name !== node.name) {
            throw new Error(`invalid pattern name "${node.name}", as prev defined "${child.getSegments()}"`)
         }
         return child;
      }

      parent.varyChildren.push(node)
      if (parent.varyChildren.length > 1) {
        parent.varyChildren.sort((a, b) => b.priority - a.priority)
      }
    } else if (doubleColonReg.test(segment)) {
        node.priority = 50 // High priority static
        parent.children[key] = node
    } else if (segment[0] === '*' || segment[0] === '(' || segment[0] === ')') {
      throw new Error(`Invalid pattern: "${node.getSegments()}"`)
    } else {
      node.priority = 50 // High priority static
      parent.children[key] = node
    }
    return node
  }

  _findNode (path) {
    const segments = path.replace(trimSlashReg, '').split('/')
    let currentNode = this.root

    for (const segment of segments) {
      const key = this._getSegmentKey(segment)

      if (currentNode.children[key]) {
        currentNode = currentNode.children[key]
      } else {
        const foundInChildren = currentNode.varyChildren.find(child => child.segment === segment)
        if (foundInChildren) {
          currentNode = foundInChildren
        } else {
          return null // Node not found
        }
      }
    }
    return currentNode
  }

  _pruneNode (node) {
    if (!node || !node.parent) {
      return
    }

    const canPrune = !node.endpoint &&
      Object.keys(node.children).length === 0 &&
      node.varyChildren.length === 0

    if (canPrune) {
      const parent = node.parent
      const segment = node.segment

      if (segment.startsWith(':') || segment.startsWith('*')) {
        const index = parent.varyChildren.findIndex(child => child === node)
        if (index > -1) {
          parent.varyChildren.splice(index, 1)
        }
      } else {
        const key = this._getSegmentKey(segment)
        delete parent.children[key]
      }

      this._pruneNode(parent)
    }
  }
}

export { Trie as default, Node, Matched }
