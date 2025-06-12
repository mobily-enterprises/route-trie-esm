/**
 * @file A sophisticated trie-based router implementation in JavaScript.
 * It supports dynamic path segments, wildcards, redirects for trailing slashes
 * and fixed paths, and efficient route matching and removal.
 */

// --- Constants for path parsing ---
const wordReg = /^\w+$/
const suffixReg = /\+[A-Za-z0-9!$%&'*+,-.:;=@_~]*$/
const doubleColonReg = /^::[A-Za-z0-9!$%&'*+,-.:;=@_~]*$/
const trimSlashReg = /^\//
const fixMultiSlashReg = /\/{2,}/g

/**
 * Represents the result of a route matching operation.
 */
class Matched {
  constructor () {
    this.node = null
    this.params = {}
    this.fpr = ''
    this.tsr = ''
  }
}

/**
 * Represents a single node in the trie structure. Each node corresponds to a path segment.
 */
class Node {
  constructor (parent) {
    this.name = ''
    this.allow = ''
    this.pattern = ''
    this.segment = ''
    this.priority = 0
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
    if (this.parent === null) { // This is the root node
        return this.segment;
    }
    const parentSegments = this.parent.getSegments();
    // Avoid double slash
    return parentSegments === '/' ? parentSegments + this.segment : parentSegments + '/' + this.segment;
  }
}

/**
 * The main Trie class for routing.
 */
class Trie {
  static NAME = 'Trie'
  static VERSION = 'v3.0.0'

  constructor (options = {}) {
    this.ignoreCase = options.ignoreCase !== false
    this.fpr = options.fixedPathRedirect !== false
    this.tsr = options.trailingSlashRedirect !== false
    this.root = new Node(null)
    this.root.segment = '/' // Give root a segment for correct path building
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
          const newPath = path.slice(0, end - 1) || '/';
          matched.tsr = newPath;
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
    if (segment === undefined) return parent;

    // Handle root case where segment is ''
    if (segment === '' && parent === this.root) {
        if (segments.length === 0) {
            if (!parent.children['']) {
                parent.children[''] = new Node(parent);
                parent.children[''].segment = '';
            }
            parent.children[''].endpoint = true;
            return parent.children[''];
        }
        return this._defineNode(parent, segments);
    }
    
    const child = this._parseNode(parent, segment)
    child.segment = segment
    if (segments.length === 0) {
      child.endpoint = true
      return child
    }
    if (child.wildcard) {
      throw new Error(`Can not define pattern after wildcard: "${child.getSegments()}"`)
    }
    return this._defineNode(child, segments)
  }

  _matchNode (parent, segment) {
    const key = this.ignoreCase ? segment.toLowerCase() : segment
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
    // Check for double-colon escape first to avoid being parsed as a dynamic param
    if (doubleColonReg.test(segment)) {
        const key = this._getSegmentKey(segment);
        if (!parent.children[key]) {
            const node = new Node(parent);
            node.priority = 50;
            parent.children[key] = node;
        }
        return parent.children[key];
    }
    
    if (segment === '') {
      const node = new Node(parent);
      node.priority = 100
      parent.children[''] = node
      return node;
    } 
    
    if (segment[0] === ':') {
      const node = new Node(parent);
      let name = segment.slice(1)
      
      switch (name[name.length - 1]) {
        case '*':
          name = name.slice(0, name.length - 1)
          node.wildcard = true
          node.priority = 1
          break;
        default:
          const n = name.search(suffixReg)
          if (n >= 0) {
            node.suffix = name.slice(n + 1);
            name = name.slice(0, n)
            node.priority = 4
          }
          if (name[name.length - 1] === ')') {
            const regexIndex = name.indexOf('(')
            if (regexIndex > 0) {
              const regex = name.slice(regexIndex + 1, name.length - 1)
              if (regex.length > 0) {
                name = name.slice(0, regexIndex)
                node.regex = new RegExp(regex)
                node.priority = (node.priority > 0 ? node.priority : 0) + 3;
              } else {
                throw new Error(`Invalid pattern: "${parent.getSegments()}${segment}"`)
              }
            }
          }
      }
      
      if (node.priority === 0) {
        node.priority = 2
      }

      // Bug Fix: Stricter validation for parameter names
      if (!wordReg.test(name) || /^[0-9]/.test(name)) {
        throw new Error(`Invalid pattern: "${parent.getSegments()}${segment}"`)
      }
      node.name = name
      
      for (const child of parent.varyChildren) {
        const isSameType = child.wildcard === node.wildcard &&
                           child.suffix === node.suffix &&
                           String(child.regex) === String(node.regex);

        if (isSameType) {
           if (child.name !== node.name) {
               throw new Error(`invalid pattern name "${node.name}", conflicts with existing "${child.segment}"`);
           }
           return child;
        }
      }
      parent.varyChildren.push(node)
      if (parent.varyChildren.length > 1) {
        parent.varyChildren.sort((a, b) => b.priority - a.priority)
      }
      return node;
    }
    
    if (segment[0] === '*' || segment[0] === '(' || segment[0] === ')') {
      throw new Error(`Invalid pattern: "${parent.getSegments()}${segment}"`)
    }
    
    // Default static node
    const key = this._getSegmentKey(segment);
    if (!parent.children[key]) {
        const node = new Node(parent);
        node.priority = 50
        parent.children[key] = node
    }
    return parent.children[key];
  }

  _findNode (path) {
    const segments = path.replace(trimSlashReg, '').split('/')
    let currentNode = this.root
    for (const segment of segments) {
      if (segment === '' && segments.length === 1) {
        return currentNode.children[''] || null;
      }
      if (segment === '' && segments.length > 1) continue;

      const key = this._getSegmentKey(segment)
      if (currentNode.children[key]) {
        currentNode = currentNode.children[key]
      } else {
        const foundInChildren = currentNode.varyChildren.find(child => child.segment === segment)
        if (foundInChildren) {
          currentNode = foundInChildren
        } else {
          return null
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

export { Trie, Node, Matched };
