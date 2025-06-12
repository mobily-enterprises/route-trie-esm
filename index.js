/**
 * @file A sophisticated trie-based router implementation in JavaScript.
 * It supports dynamic path segments, wildcards, redirects for trailing slashes
 * and fixed paths, and efficient route matching and removal.
 */

// --- Constants for path parsing ---

// The valid characters for the path component, based on RFC 3986.
// See: http://stackoverflow.com/questions/4669692/valid-characters-for-directory-part-of-a-url-for-short-links
// See: https://tools.ietf.org/html/rfc3986#section-3.3

/**
 * Matches word characters (e.g., for parameter names). Equivalent to [A-Za-z0-9_].
 * @type {RegExp}
 */
const wordReg = /^\w+$/

/**
 * Matches a suffix on a dynamic parameter, e.g., ":id+.json".
 * @type {RegExp}
 */
const suffixReg = /\+[A-Za-z0-9!$%&'*+,-.:;=@_~]*$/

/**
 * Matches a double-colon prefix, used to escape a colon in a path segment.
 * e.g., "::foo" becomes ":foo" literally, not a parameter.
 * @type {RegExp}
 */
const doubleColonReg = /^::[A-Za-z0-9!$%&'*+,-.:;=@_~]*$/

/**
 * Matches a leading slash for trimming.
 * @type {RegExp}
 */
const trimSlashReg = /^\//

/**
 * Matches two or more consecutive slashes for path normalization.
 * @type {RegExp}
 */
const fixMultiSlashReg = /\/{2,}/g

/**
 * Represents the result of a route matching operation.
 */
class Matched {
  constructor () {
    /**
     * A reference to the matched Node object if a route is found, otherwise null.
     * @type {Node|null}
     */
    this.node = null

    /**
     * An object containing the extracted dynamic parameters from the URL.
     * @type {Object<string, string>}
     */
    this.params = {}

    /**
     * If Fixed Path Redirect is enabled, this may contain a suggested redirect path
     * to a canonical URL (e.g., correcting multiple slashes). Otherwise, it's an empty string.
     * @type {string}
     */
    this.fpr = ''

    /**
     * If Trailing Slash Redirect is enabled, this may contain a suggested redirect path
     * to a URL with or without a trailing slash. Otherwise, it's an empty string.
     * @type {string}
     */
    this.tsr = ''
  }
}

/**
 * Represents a single node in the trie structure. Each node corresponds to a path segment.
 */
class Node {
  /**
   * @param {Node|null} parent A reference to the parent node.
   */
  constructor (parent) {
    /** @type {string} The name of the dynamic parameter, if any (e.g., "id"). */
    this.name = ''
    /** @type {string} A comma-separated list of allowed HTTP methods for this node. */
    this.allow = ''
    /** @type {string} The full route pattern that terminates at this node. */
    this.pattern = ''
    /** @type {string} The original path segment this node represents (e.g., ":id" or "users"). */
    this.segment = ''
    /** @type {number} The priority used for sorting dynamic (`varyChildren`) routes. */
    this.priority = 0
    /** @type {string} A static suffix for a dynamic parameter (e.g., ".json"). */
    this.suffix = ''
    /** @type {RegExp|null} A regular expression for validating a dynamic parameter. */
    this.regex = null
    /** @type {boolean} True if this node represents the end of a defined route. */
    this.endpoint = false
    /** @type {boolean} True if this node is a wildcard parameter (e.g., "*filepath"). */
    this.wildcard = false
    /** @type {Node[]} An array of dynamic child nodes, sorted by priority. */
    this.varyChildren = []
    /** @type {Node|null} A reference to the parent node. */
    this.parent = parent
    /** @type {Object<string, Node>} A map of static child nodes. */
    this.children = Object.create(null)
    /** @type {Object<string, function>} A map of HTTP methods to their handler functions. */
    this.handlers = Object.create(null)
  }

  /**
   * Associates a handler function with an HTTP method for this node.
   * @param {string} method The HTTP method (e.g., "GET").
   * @param {function} handler The handler function for this route and method.
   */
  handle (method, handler) {
    if (handler == null) {
      throw new TypeError('handler should not be null')
    }
    if (this.handlers[method] != null) {
      throw new Error(`"${method}" already defined`)
    }
    this.handlers[method] = handler
    // Update the list of allowed methods.
    if (this.allow === '') {
      this.allow = method
    } else {
      this.allow += ', ' + method
    }
  }

  /**
   * Retrieves the handler for a specific HTTP method.
   * @param {string} method The HTTP method.
   * @returns {function|null} The handler function or null if not found.
   */
  getHandler (method) {
    return this.handlers[method] == null ? null : this.handlers[method]
  }

  /**
   * Returns the string of allowed HTTP methods.
   * @returns {string}
   */
  getAllow () {
    return this.allow
  }

  /**
   * Returns the full route pattern for this node.
   * @returns {string}
   */
  getPattern () {
    return this.pattern
  }

  /**
   * Recursively reconstructs the full path segment string up to this node.
   * @returns {string}
   */
  getSegments () {
    let segments = this.segment
    if (this.parent != null) {
      segments = this.parent.getSegments() + '/' + segments
    }
    return segments
  }
}

/**
 * The main Trie class for routing.
 */
export class Trie {
  static NAME = 'Trie'
  static VERSION = 'v3.0.0'

  /**
   * @param {object} [options={}] Configuration options for the trie.
   * @param {boolean} [options.ignoreCase=true] If true, routes are matched case-insensitively.
   * @param {boolean} [options.fixedPathRedirect=true] If true, redirects for paths with extra slashes.
   * @param {boolean} [options.trailingSlashRedirect=true] If true, redirects for trailing slashes.
   */
  constructor (options = {}) {
    this.ignoreCase = options.ignoreCase !== false
    this.fpr = options.fixedPathRedirect !== false
    this.tsr = options.trailingSlashRedirect !== false
    this.root = new Node(null)
  }

  /**
   * Defines a new route pattern in the trie.
   * @param {string} pattern The route pattern (e.g., "/users/:id").
   * @returns {Node} The terminal node for the defined pattern.
   */
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

  /**
   * Matches a given URL path against the routes defined in the trie.
   * @param {string} path The URL path to match.
   * @returns {Matched} A Matched object containing the result.
   */
  match (path) {
    if (typeof path !== 'string') {
      throw new TypeError('Path must be string.')
    }
    if (path === '' || path[0] !== '/') {
      throw new Error(`Path is not start with "/": "${path}"`)
    }
    // Normalize path for Fixed Path Redirect check.
    let fixedLen = path.length
    if (this.fpr) {
      path = path.replace(fixMultiSlashReg, '/')
      fixedLen -= path.length
    }

    let start = 1
    let parent = this.root
    const end = path.length
    const matched = new Matched()

    // Iterate through path segments.
    for (let i = 1; i <= end; i++) {
      if (i < end && path[i] !== '/') {
        continue
      }

      let segment = path.slice(start, i)
      let node = this._matchNode(parent, segment)
      
      // If case-insensitive, try matching lowercased segment.
      if (this.ignoreCase && node == null) {
        node = this._matchNode(parent, segment.toLowerCase())
      }
      
      if (node == null) {
        // Handle Trailing Slash Redirect: /users/ -> /users
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
      // Extract parameters if it's a dynamic node.
      if (parent.name !== '') {
        if (parent.wildcard) {
          matched.params[parent.name] = path.slice(start, end)
          break // Wildcard matches the rest of the path.
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
      // Handle Fixed Path Redirect.
      if (this.fpr && fixedLen > 0) {
        matched.fpr = path
        matched.node = null
      }
    } else if (this.tsr && parent.children[''] != null) {
      // Handle Trailing Slash Redirect: /users -> /users/
      matched.tsr = path + '/'
      if (this.fpr && fixedLen > 0) {
        matched.fpr = matched.tsr
        matched.tsr = ''
      }
    }
    return matched
  }

  /**
   * Removes a route from the trie.
   * @param {string} path The exact route pattern to remove.
   */
  remove (path) {
    if (typeof path !== 'string') {
      throw new TypeError('Path must be a string.')
    }
    if (path === '' || path[0] !== '/') {
      throw new Error(`Path must start with "/": "${path}"`)
    }

    // Find the node corresponding to the exact path definition.
    const node = this._findNode(path)
    if (!node) {
      return // Path not found.
    }

    // Deactivate the endpoint.
    node.endpoint = false
    node.handlers = Object.create(null)
    node.allow = ''

    // Prune unnecessary parent nodes.
    this._pruneNode(node)
  }

  // --- Private Methods ---

  /**
   * Generates a key for the `children` map from a path segment,
   * applying case-insensitivity if enabled.
   * @param {string} segment The path segment.
   * @returns {string} The normalized key.
   * @private
   */
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

  /**
   * Recursively defines a node in the trie based on path segments.
   * @param {Node} parent The parent node.
   * @param {string[]} segments An array of path segments.
   * @returns {Node} The terminal node for the path.
   * @private
   */
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

  /**
   * Finds a matching child node for a given segment.
   * @param {Node} parent The node to search within.
   * @param {string} segment The path segment to match.
   * @returns {Node|null} The matched node or null.
   * @private
   */
  _matchNode (parent, segment) {
    // First, check for a static match in the children map.
    const key = this.ignoreCase ? segment.toLowerCase() : segment;
    if (parent.children[key] != null) {
      return parent.children[key]
    }
    
    // If no static match, check dynamic children (`varyChildren`).
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

  /**
   * Parses a segment to create a new Node, determining if it's static or dynamic.
   * @param {Node} parent The parent node.
   * @param {string} segment The segment to parse.
   * @returns {Node} The newly created or existing node.
   * @private
   */
  _parseNode (parent, segment) {
    const key = this._getSegmentKey(segment)

    // Return existing node if it's a static path that's already defined.
    if (parent.children[key] != null) {
      return parent.children[key]
    }

    const node = new Node(parent)

    if (segment === '') {
        // Highest priority for routes ending in a trailing slash (e.g., /users/).
        node.priority = 100
        parent.children[''] = node
    } else if (segment[0] === ':') {
      // Dynamic segment parsing.
      let name = segment.slice(1)

      switch (name[name.length - 1]) {
        case '*': // Wildcard parameter (e.g., :filepath*)
          name = name.slice(0, name.length - 1)
          node.wildcard = true
          node.priority = 1 // Lowest priority.
          break
        default:
          const n = name.search(suffixReg)
          if (n >= 0) { // Parameter with suffix (e.g., :file+.zip)
            node.suffix = name.slice(n + 1)
            name = name.slice(0, n)
            node.priority = 4 // Higher than regex.
            if (node.suffix === '') {
              throw new Error(`invalid pattern: "${node.getSegments()}"`)
            }
          }

          if (name[name.length - 1] === ')') { // Parameter with regex (e.g., :id(\\d+))
            const i = name.indexOf('(')
            if (i > 0) {
              const regex = name.slice(i + 1, name.length - 1)
              if (regex.length > 0) {
                name = name.slice(0, i)
                node.regex = new RegExp(regex)
                node.priority = 3 // Higher than simple param.
              } else {
                throw new Error(`Invalid pattern: "${node.getSegments()}"`)
              }
            }
          }
      }
      
      // Default priority for simple parameters (e.g., :id).
      if (node.priority === 0) {
          node.priority = 2
      }

      if (!wordReg.test(name)) {
        throw new Error(`Invalid pattern: "${node.getSegments()}"`)
      }
      node.name = name

      // Check for duplicate dynamic routes.
      for (const child of parent.varyChildren) {
         if (child.wildcard !== node.wildcard || child.suffix !== node.suffix || 
            (child.regex && node.regex && child.regex.toString() !== node.regex.toString())) {
             continue;
         }
         if (child.name !== node.name) {
            throw new Error(`invalid pattern name "${node.name}", as prev defined "${child.getSegments()}"`)
         }
         return child; // Return existing node if a functionally identical one exists.
      }

      // Add new dynamic node and re-sort by priority.
      parent.varyChildren.push(node)
      if (parent.varyChildren.length > 1) {
        parent.varyChildren.sort((a, b) => b.priority - a.priority)
      }
    } else if (doubleColonReg.test(segment)) {
        // Escaped colon segment.
        node.priority = 50 // High priority (static).
        parent.children[key] = node
    } else if (segment[0] === '*' || segment[0] === '(' || segment[0] === ')') {
      throw new Error(`Invalid pattern: "${node.getSegments()}"`)
    } else {
      // Static segment.
      node.priority = 50 // High priority.
      parent.children[key] = node
    }
    return node
  }

  /**
   * Finds a node by its exact definition path. Used for removal.
   * @param {string} path The exact route pattern.
   * @returns {Node|null} The found node or null.
   * @private
   */
  _findNode (path) {
    const segments = path.replace(trimSlashReg, '').split('/')
    let currentNode = this.root

    for (const segment of segments) {
      const key = this._getSegmentKey(segment)

      // Traverses based on the *definition* of the path, not just matching.
      if (currentNode.children[key]) {
        currentNode = currentNode.children[key]
      } else {
        // For dynamic routes, find the child with the matching original segment.
        const foundInChildren = currentNode.varyChildren.find(child => child.segment === segment)
        if (foundInChildren) {
          currentNode = foundInChildren
        } else {
          return null // Node not found.
        }
      }
    }
    return currentNode
  }

  /**
   * Recursively prunes a node and its ancestors if they are no longer necessary.
   * A node is unnecessary if it's not an endpoint and has no children.
   * @param {Node} node The node to start pruning from.
   * @private
   */
  _pruneNode (node) {
    if (!node || !node.parent) {
      return // Stop at the root.
    }

    const canPrune = !node.endpoint &&
      Object.keys(node.children).length === 0 &&
      node.varyChildren.length === 0

    if (canPrune) {
      const parent = node.parent
      const segment = node.segment

      // Remove from the correct parent array (static or dynamic).
      if (segment.startsWith(':') || segment.startsWith('*')) {
        const index = parent.varyChildren.findIndex(child => child === node)
        if (index > -1) {
          parent.varyChildren.splice(index, 1)
        }
      } else {
        const key = this._getSegmentKey(segment)
        delete parent.children[key]
      }

      // Recursively prune the parent.
      this._pruneNode(parent)
    }
  }
}

export { Trie as default, Node, Matched }
