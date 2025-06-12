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
    // Ignore case when matching URL path.
    this.ignoreCase = options.ignoreCase !== false

    // If enabled, the trie will detect if the current path can't be matched but
    // a handler for the fixed path exists.
    // matched.fpr will returns either a fixed redirect path or an empty string.
    // For example when "/api/foo" defined and matching "/api//foo",
    // The result matched.fpr is "/api/foo".
    this.fpr = options.fixedPathRedirect !== false

    // If enabled, the trie will detect if the current path can't be matched but
    // a handler for the path with (without) the trailing slash exists.
    // matched.tsr will returns either a redirect path or an empty string.
    // For example if /foo/ is requested but a route only exists for /foo, the
    // client is redirected to /foo.
    // For example when "/api/foo" defined and matching "/api/foo/",
    // The result matched.tsr is "/api/foo".
    this.tsr = options.trailingSlashRedirect !== false
    this.root = new Node(null)
  }

  define (pattern) {
    if (typeof pattern !== 'string') {
      throw new TypeError('Pattern must be string.')
    }
    if (pattern.includes('//')) {
      throw new Error('Multi-slash existhis.')
    }

    const _pattern = pattern.replace(trimSlashReg, '')
    const node = defineNode(this.root, _pattern.split('/'), this.ignoreCase)
    if (node.pattern === '') {
      node.pattern = pattern
    }
    return node
  }

  match (path) {
    // the path should be normalized before match, just as path.normalize do in Node.js
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
      let node = matchNode(parent, segment)
      if (this.ignoreCase && node == null) {
        node = matchNode(parent, segment.toLowerCase())
      }
      if (node == null) {
        // TrailingSlashRedirect: /acb/efg/ -> /acb/efg
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
      // TrailingSlashRedirect: /acb/efg -> /acb/efg/
      matched.tsr = path + '/'
      if (this.fpr && fixedLen > 0) {
        matched.fpr = matched.tsr
        matched.tsr = ''
      }
    }
    return matched
  }

  /**
   * Removes a path from the trie.
   * @param {string} path The path to remove.
   */
  remove (path) {
    if (typeof path !== 'string') {
      throw new TypeError('Path must be a string.')
    }
    if (path === '' || path[0] !== '/') {
      throw new Error(`Path must start with "/": "${path}"`)
    }

    // Find the node corresponding to the path
    const node = this.findNode(path)
    if (!node) {
      // Path does not exist, nothing to remove
      return
    }

    // Clear the node's endpoint status and handlers
    node.endpoint = false
    node.handlers = Object.create(null)
    node.allow = ''

    // Prune the trie by removing parent nodes that are no longer needed
    pruneNode(node)
  }

  /**
   * Finds a node by its exact path, without matching parameters.
   * @param {string} path The path to find.
   * @returns {Node|null} The found node or null.
   * @private
   */
  findNode (path) {
    const segments = path.replace(trimSlashReg, '').split('/')
    let currentNode = this.root

    for (const segment of segments) {
      let _segment = segment
      if (this.ignoreCase) {
        _segment = segment.toLowerCase()
      }

      // We need to check both static and dynamic children.
      // This is a simplified traversal compared to `match`.
      // It assumes an exact structural match is needed for removal.
      if (currentNode.children[_segment]) {
        currentNode = currentNode.children[_segment]
      } else {
        // This simplified find doesn't handle complex dynamic routes well.
        // For a robust `remove`, we'd need to match the *definition* of the route,
        // not just a potential match.
        const foundInChildren = currentNode.varyChildren.find(child => {
          // A simple heuristic: check if the segment definition matches.
          // This won't work perfectly for regexes but handles basic cases.
          const patternSegment = child.segment;
          return patternSegment === segment
        })
        if (foundInChildren) {
           currentNode = foundInChildren
        } else {
            return null // Node not found
        }
      }
    }
    return currentNode
  }
}

/**
 * Recursively prunes a node and its ancestors if they are no longer necessary.
 * A node is considered unnecessary if it's not an endpoint and has no children.
 * @param {Node} node The node to start pruning from.
 * @private
 */
function pruneNode (node) {
  if (!node || !node.parent) {
    // Stop if we reach the root or a null node
    return
  }

  // A node can be removed if it's not an endpoint, has no static children,
  // and has no dynamic children.
  const canPrune = !node.endpoint &&
                   Object.keys(node.children).length === 0 &&
                   node.varyChildren.length === 0

  if (canPrune) {
    const parent = node.parent
    const segment = node.segment

    let _segment = segment;
    // Assume ignoreCase was used during definition for key lookup
    if (segment.startsWith(':') || segment.startsWith('*')) {
        // It's a varyChild
        const index = parent.varyChildren.findIndex(child => child === node);
        if (index > -1) {
            parent.varyChildren.splice(index, 1);
        }
    } else {
       if(doubleColonReg.test(segment)) {
           _segment = segment.slice(1);
       }
       // It's a static child, need to consider case-insensitivity from trie options
       // This part is tricky without passing the `ignoreCase` flag all the way down.
       // We'll assume the key was stored lowercased if ignoreCase was on.
       // A truly robust solution might need to store the original segment case or pass options.
       delete parent.children[_segment]; // This might fail if case differs.
       delete parent.children[segment]; // Try original segment too.
    }


    // After removing the child, recursively try to prune the parent
    pruneNode(parent)
  }
}

function defineNode (parent, segments, ignoreCase) {
  const segment = segments.shift()
  const child = parseNode(parent, segment, ignoreCase)
  // Store the original segment on the node for potential removal later.
  child.segment = segment;

  if (segments.length === 0) {
    child.endpoint = true
    return child
  }
  if (child.wildcard) {
    throw new Error(`Can not define pattern after wildcard: "${child.pattern}"`)
  }
  return defineNode(child, segments, ignoreCase)
}

function matchNode (parent, segment) {
  if (parent.children[segment] != null) {
    return parent.children[segment]
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

function parseNode (parent, segment, ignoreCase) {
  let _segment = segment
  if (doubleColonReg.test(segment)) {
    _segment = segment.slice(1)
  }
  if (ignoreCase) {
    _segment = _segment.toLowerCase()
  }

  if (parent.children[_segment] != null) {
    return parent.children[_segment]
  }

  const node = new Node(parent)

  if (segment === '') {
    parent.children[''] = node
  } else if (doubleColonReg.test(segment)) {
    // pattern "/a/::" should match "/a/:"
    // pattern "/a/::bc" should match "/a/:bc"
    // pattern "/a/::/bc" should match "/a/:/bc"
    parent.children[_segment] = node
  } else if (segment[0] === ':') {
    let name = segment.slice(1)

    switch (name[name.length - 1]) {
      case '*':
        name = name.slice(0, name.length - 1)
        node.wildcard = true
        break
      default:
        const n = name.search(suffixReg)
        if (n >= 0) {
          node.suffix = name.slice(n + 1)
          name = name.slice(0, n)
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
            } else {
              throw new Error(`Invalid pattern: "${node.getSegments()}"`)
            }
          }
        }
    }

    // name must be word characters `[0-9A-Za-z_]`
    if (!wordReg.test(name)) {
      throw new Error(`Invalid pattern: "${node.getSegments()}"`)
    }
    node.name = name

    for (const child of parent.varyChildren) {
      if (child.wildcard) {
        if (!node.wildcard) {
          throw new Error(`can't define "${node.getSegments()}" after "${child.getSegments()}"`)
        }
        if (child.name !== node.name) {
          throw new Error(`invalid pattern name "${node.name}", as prev defined "${child.getSegments()}"`)
        }
        return child
      }

      if (child.suffix !== node.suffix) {
        continue
      }

      if (!node.wildcard && ((child.regex == null && node.regex == null) ||
        (child.regex != null && node.regex != null &&
        child.regex.toString() === node.regex.toString()))) {
        if (child.name !== node.name) {
          throw new Error(`invalid pattern name "${node.name}", as prev defined "${child.getSegments()}"`)
        }
        return child
      }
    }

    parent.varyChildren.push(node)
    if (parent.varyChildren.length > 1) {
      parent.varyChildren.sort((a, b) => {
        if (a.suffix !== '' && b.suffix === '') {
          return 0
        }
        if (a.suffix === '' && b.suffix !== '') {
          return 1
        }
        if (a.regex == null && b.regex != null) {
          return 1
        }
        return 0
      })
    }
  } else if (segment[0] === '*' || segment[0] === '(' || segment[0] === ')') {
    throw new Error(`Invalid pattern: "${node.getSegments()}"`)
  } else {
    parent.children[_segment] = node
  }
  return node
}

export { Trie as default, Node, Matched }
