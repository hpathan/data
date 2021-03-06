/**
  @module data
  @submodule data-model
*/

var get = Ember.get, set = Ember.set,
    once = Ember.run.once, arrayMap = Ember.ArrayPolyfills.map;

/**
  This file encapsulates the various states that a record can transition
  through during its lifecycle.

  ### State Manager

  A record's state manager explicitly tracks what state a record is in
  at any given time. For instance, if a record is newly created and has
  not yet been sent to the adapter to be saved, it would be in the
  `created.uncommitted` state.  If a record has had local modifications
  made to it that are in the process of being saved, the record would be
  in the `updated.inFlight` state. (These state paths will be explained
  in more detail below.)

  Events are sent by the record or its store to the record's state manager.
  How the state manager reacts to these events is dependent on which state
  it is in. In some states, certain events will be invalid and will cause
  an exception to be raised.

  States are hierarchical. For example, a record can be in the
  `deleted.start` state, then transition into the `deleted.inFlight` state.
  If a child state does not implement an event handler, the state manager
  will attempt to invoke the event on all parent states until the root state is
  reached. The state hierarchy of a record is described in terms of a path
  string. You can determine a record's current state by getting its manager's
  current state path:

      record.get('stateManager.currentPath');
      //=> "created.uncommitted"

  The `DS.Model` states are themselves stateless. What we mean is that,
  though each instance of a record also has a unique instance of a
  `DS.StateManager`, the hierarchical states that each of *those* points
  to is a shared data structure. For performance reasons, instead of each
  record getting its own copy of the hierarchy of states, each state
  manager points to this global, immutable shared instance. How does a
  state know which record it should be acting on?  We pass a reference to
  the current state manager as the first parameter to every method invoked
  on a state.

  The state manager passed as the first parameter is where you should stash
  state about the record if needed; you should never store data on the state
  object itself. If you need access to the record being acted on, you can
  retrieve the state manager's `record` property. For example, if you had
  an event handler `myEvent`:

      myEvent: function(manager) {
        var record = manager.get('record');
        record.doSomething();
      }

  For more information about state managers in general, see the Ember.js
  documentation on `Ember.StateManager`.

  ### Events, Flags, and Transitions

  A state may implement zero or more events, flags, or transitions.

  #### Events

  Events are named functions that are invoked when sent to a record. The
  state manager will first look for a method with the given name on the
  current state. If no method is found, it will search the current state's
  parent, and then its grandparent, and so on until reaching the top of
  the hierarchy. If the root is reached without an event handler being found,
  an exception will be raised. This can be very helpful when debugging new
  features.

  Here's an example implementation of a state with a `myEvent` event handler:

      aState: DS.State.create({
        myEvent: function(manager, param) {
          console.log("Received myEvent with "+param);
        }
      })

  To trigger this event:

      record.send('myEvent', 'foo');
      //=> "Received myEvent with foo"

  Note that an optional parameter can be sent to a record's `send()` method,
  which will be passed as the second parameter to the event handler.

  Events should transition to a different state if appropriate. This can be
  done by calling the state manager's `transitionTo()` method with a path to the
  desired state. The state manager will attempt to resolve the state path
  relative to the current state. If no state is found at that path, it will
  attempt to resolve it relative to the current state's parent, and then its
  parent, and so on until the root is reached. For example, imagine a hierarchy
  like this:

      * created
        * start <-- currentState
        * inFlight
      * updated
        * inFlight

  If we are currently in the `start` state, calling
  `transitionTo('inFlight')` would transition to the `created.inFlight` state,
  while calling `transitionTo('updated.inFlight')` would transition to
  the `updated.inFlight` state.

  Remember that *only events* should ever cause a state transition. You should
  never call `transitionTo()` from outside a state's event handler. If you are
  tempted to do so, create a new event and send that to the state manager.

  #### Flags

  Flags are Boolean values that can be used to introspect a record's current
  state in a more user-friendly way than examining its state path. For example,
  instead of doing this:

      var statePath = record.get('stateManager.currentPath');
      if (statePath === 'created.inFlight') {
        doSomething();
      }

  You can say:

      if (record.get('isNew') && record.get('isSaving')) {
        doSomething();
      }

  If your state does not set a value for a given flag, the value will
  be inherited from its parent (or the first place in the state hierarchy
  where it is defined).

  The current set of flags are defined below. If you want to add a new flag,
  in addition to the area below, you will also need to declare it in the
  `DS.Model` class.

  #### Transitions

  Transitions are like event handlers but are called automatically upon
  entering or exiting a state. To implement a transition, just call a method
  either `enter` or `exit`:

      myState: DS.State.create({
        // Gets called automatically when entering
        // this state.
        enter: function(manager) {
          console.log("Entered myState");
        }
      })

  Note that enter and exit events are called once per transition. If the
  current state changes, but changes to another child state of the parent,
  the transition event on the parent will not be triggered.

  @class States
  @namespace DS
  @extends Ember.State
*/

var hasDefinedProperties = function(object) {
  // Ignore internal property defined by simulated `Ember.create`.
  var names = Ember.keys(object);
  var i, l, name;
  for (i = 0, l = names.length; i < l; i++ ) {
    name = names[i];
    if (object.hasOwnProperty(name) && object[name]) { return true; }
  }

  return false;
};

var didChangeData = function(record) {
  record.materializeData();
};

var willSetProperty = function(record, context) {
  context.oldValue = get(record, context.name);

  var change = DS.AttributeChange.createChange(context);
  record._changesToSync[context.name] = change;
};

var didSetProperty = function(record, context) {
  var change = record._changesToSync[context.name];
  change.value = get(record, context.name);
  change.sync();
};


// Implementation notes:
//
// Each state has a boolean value for all of the following flags:
//
// * isLoaded: The record has a populated `data` property. When a
//   record is loaded via `store.find`, `isLoaded` is false
//   until the adapter sets it. When a record is created locally,
//   its `isLoaded` property is always true.
// * isDirty: The record has local changes that have not yet been
//   saved by the adapter. This includes records that have been
//   created (but not yet saved) or deleted.
// * isSaving: The record's transaction has been committed, but
//   the adapter has not yet acknowledged that the changes have
//   been persisted to the backend.
// * isDeleted: The record was marked for deletion. When `isDeleted`
//   is true and `isDirty` is true, the record is deleted locally
//   but the deletion was not yet persisted. When `isSaving` is
//   true, the change is in-flight. When both `isDirty` and
//   `isSaving` are false, the change has persisted.
// * isError: The adapter reported that it was unable to save
//   local changes to the backend. This may also result in the
//   record having its `isValid` property become false if the
//   adapter reported that server-side validations failed.
// * isNew: The record was created on the client and the adapter
//   did not yet report that it was successfully saved.
// * isValid: No client-side validations have failed and the
//   adapter did not report any server-side validation failures.

// The dirty state is a abstract state whose functionality is
// shared between the `created` and `updated` states.
//
// The deleted state shares the `isDirty` flag with the
// subclasses of `DirtyState`, but with a very different
// implementation.
//
// Dirty states have three child states:
//
// `uncommitted`: the store has not yet handed off the record
//   to be saved.
// `inFlight`: the store has handed off the record to be saved,
//   but the adapter has not yet acknowledged success.
// `invalid`: the record has invalid information and cannot be
//   send to the adapter yet.
var DirtyState = {
  initialState: 'uncommitted',

  // FLAGS
  isDirty: true,

  // SUBSTATES

  // When a record first becomes dirty, it is `uncommitted`.
  // This means that there are local pending changes, but they
  // have not yet begun to be saved, and are not invalid.
  uncommitted: {

    // EVENTS
    willSetProperty: willSetProperty,
    didSetProperty: didSetProperty,

    becomeDirty: Ember.K,

    willCommit: function(record) {
      record.transitionTo('inFlight');
    },

    becameClean: function(record) {
      record.withTransaction(function(t) {
        t.remove(record);
      });

      record.transitionTo('loaded.materializing');
    },

    becameInvalid: function(record) {
      record.transitionTo('invalid');
    },

    rollback: function(record) {
      record.rollback();
    }
  },

  // Once a record has been handed off to the adapter to be
  // saved, it is in the 'in flight' state. Changes to the
  // record cannot be made during this window.
  inFlight: {
    // FLAGS
    isSaving: true,

    // TRANSITIONS
    enter: function(record) {
      record.becameInFlight();
    },

    // EVENTS

    materializingData: function(record) {
      set(record, 'lastDirtyType', get(this, 'dirtyType'));
      record.transitionTo('materializing');
    },

    didCommit: function(record) {
      var dirtyType = get(this, 'dirtyType');

      record.withTransaction(function(t) {
        t.remove(record);
      });

      record.transitionTo('saved');
      record.send('invokeLifecycleCallbacks', dirtyType);
    },

    didChangeData: didChangeData,

    becameInvalid: function(record, errors) {
      set(record, 'errors', errors);

      record.transitionTo('invalid');
      record.send('invokeLifecycleCallbacks');
    },

    becameError: function(record) {
      record.transitionTo('error');
      record.send('invokeLifecycleCallbacks');
    }
  },

  // A record is in the `invalid` state when its client-side
  // invalidations have failed, or if the adapter has indicated
  // the the record failed server-side invalidations.
  invalid: {
    // FLAGS
    isValid: false,

    exit: function(record) {
       record.withTransaction(function (t) {
         t.remove(record);
       });
     },

    // EVENTS
    deleteRecord: function(record) {
      record.transitionTo('deleted.uncommitted');
      record.clearRelationships();
    },

    willSetProperty: willSetProperty,

    didSetProperty: function(record, context) {
      var errors = get(record, 'errors'),
          key = context.name;

      set(errors, key, null);

      if (!hasDefinedProperties(errors)) {
        record.send('becameValid');
      }

      didSetProperty(record, context);
    },

    becomeDirty: Ember.K,

    rollback: function(record) {
      record.send('becameValid');
      record.send('rollback');
    },

    becameValid: function(record) {
      record.transitionTo('uncommitted');
    },

    invokeLifecycleCallbacks: function(record) {
      record.trigger('becameInvalid', record);
    }
  }
};

// The created and updated states are created outside the state
// chart so we can reopen their substates and add mixins as
// necessary.

function deepClone(object) {
  var clone = {}, value;

  for (var prop in object) {
    value = object[prop];
    if (value && typeof value === 'object') {
      clone[prop] = deepClone(value);
    } else {
      clone[prop] = value;
    }
  }

  return clone;
}

function mixin(original, hash) {
  for (var prop in hash) {
    original[prop] = hash[prop];
  }

  return original;
}

function dirtyState(options) {
  var newState = deepClone(DirtyState);
  return mixin(newState, options);
}

var createdState = dirtyState({
  dirtyType: 'created',

  // FLAGS
  isNew: true
});

var updatedState = dirtyState({
  dirtyType: 'updated'
});

createdState.uncommitted.deleteRecord = function(record) {
  record.clearRelationships();
  record.transitionTo('deleted.saved');
};

createdState.uncommitted.rollback = function(record) {
  DirtyState.uncommitted.rollback.apply(this, arguments);
  record.transitionTo('deleted.saved');
};

updatedState.uncommitted.deleteRecord = function(record) {
  record.transitionTo('deleted.uncommitted');
  record.clearRelationships();
};

var RootState = {
  // FLAGS
  isLoading: false,
  isLoaded: false,
  isReloading: false,
  isDirty: false,
  isSaving: false,
  isDeleted: false,
  isError: false,
  isNew: false,
  isValid: true,

  // SUBSTATES

  // A record begins its lifecycle in the `empty` state.
  // If its data will come from the adapter, it will
  // transition into the `loading` state. Otherwise, if
  // the record is being created on the client, it will
  // transition into the `created` state.
  empty: {
    // EVENTS
    loadingData: function(record) {
      record.transitionTo('loading');
    },

    loadedData: function(record) {
      record.transitionTo('loaded.created.uncommitted');
    }
  },

  // A record enters this state when the store askes
  // the adapter for its data. It remains in this state
  // until the adapter provides the requested data.
  //
  // Usually, this process is asynchronous, using an
  // XHR to retrieve the data.
  loading: {
    // FLAGS
    isLoading: true,

    // EVENTS
    loadedData: didChangeData,

    materializingData: function(record) {
      record.transitionTo('loaded.materializing.firstTime');
    },

    becameError: function(record) {
      record.transitionTo('error');
      record.send('invokeLifecycleCallbacks');
    }
  },

  // A record enters this state when its data is populated.
  // Most of a record's lifecycle is spent inside substates
  // of the `loaded` state.
  loaded: {
    initialState: 'saved',

    // FLAGS
    isLoaded: true,

    // SUBSTATES

    materializing: {
      // EVENTS
      willSetProperty: Ember.K,
      didSetProperty: Ember.K,

      didChangeData: didChangeData,

      finishedMaterializing: function(record) {
        record.transitionTo('loaded.saved');
      },

      // SUBSTATES
      firstTime: {
        // FLAGS
        isLoaded: false,

        exit: function(record) {
          once(function() {
            record.trigger('didLoad');
          });
        }
      }
    },

    reloading: {
      // FLAGS
      isReloading: true,

      // TRANSITIONS
      enter: function(record) {
        var store = get(record, 'store');
        store.reloadRecord(record);
      },

      exit: function(record) {
        once(record, 'trigger', 'didReload');
      },

      // EVENTS
      loadedData: didChangeData,

      materializingData: function(record) {
        record.transitionTo('loaded.materializing');
      }
    },

    // If there are no local changes to a record, it remains
    // in the `saved` state.
    saved: {
      // EVENTS
      willSetProperty: willSetProperty,
      didSetProperty: didSetProperty,

      didChangeData: didChangeData,
      loadedData: didChangeData,

      reloadRecord: function(record) {
        record.transitionTo('loaded.reloading');
      },

      materializingData: function(record) {
        record.transitionTo('loaded.materializing');
      },

      becomeDirty: function(record) {
        record.transitionTo('updated.uncommitted');
      },

      deleteRecord: function(record) {
        record.transitionTo('deleted.uncommitted');
        record.clearRelationships();
      },

      unloadRecord: function(record) {
        // clear relationships before moving to deleted state
        // otherwise it fails
        record.clearRelationships();
        record.transitionTo('deleted.saved');
      },

      didCommit: function(record) {
        record.withTransaction(function(t) {
          t.remove(record);
        });

        record.send('invokeLifecycleCallbacks', get(record, 'lastDirtyType'));
      },

      invokeLifecycleCallbacks: function(record, dirtyType) {
        if (dirtyType === 'created') {
          record.trigger('didCreate', record);
        } else {
          record.trigger('didUpdate', record);
        }

        record.trigger('didCommit', record);
      }
    },

    // A record is in this state after it has been locally
    // created but before the adapter has indicated that
    // it has been saved.
    created: createdState,

    // A record is in this state if it has already been
    // saved to the server, but there are new local changes
    // that have not yet been saved.
    updated: updatedState
  },

  // A record is in this state if it was deleted from the store.
  deleted: {
    initialState: 'uncommitted',
    dirtyType: 'deleted',

    // FLAGS
    isDeleted: true,
    isLoaded: true,
    isDirty: true,

    // TRANSITIONS
    setup: function(record) {
      var store = get(record, 'store');

      store.recordArrayManager.remove(record);
    },

    // SUBSTATES

    // When a record is deleted, it enters the `start`
    // state. It will exit this state when the record's
    // transaction starts to commit.
    uncommitted: {

      // EVENTS
      willCommit: function(record) {
        record.transitionTo('inFlight');
      },

      rollback: function(record) {
        record.rollback();
      },

      becomeDirty: Ember.K,

      becameClean: function(record) {
        record.withTransaction(function(t) {
          t.remove(record);
        });
        record.transitionTo('loaded.materializing');
      }
    },

    // After a record's transaction is committing, but
    // before the adapter indicates that the deletion
    // has saved to the server, a record is in the
    // `inFlight` substate of `deleted`.
    inFlight: {
      // FLAGS
      isSaving: true,

      // TRANSITIONS
      enter: function(record) {
        record.becameInFlight();
      },

      // EVENTS
      didCommit: function(record) {
        record.withTransaction(function(t) {
          t.remove(record);
        });

        record.transitionTo('saved');

        record.send('invokeLifecycleCallbacks');
      }
    },

    // Once the adapter indicates that the deletion has
    // been saved, the record enters the `saved` substate
    // of `deleted`.
    saved: {
      // FLAGS
      isDirty: false,

      setup: function(record) {
        var store = get(record, 'store');
        store.dematerializeRecord(record);
      },

      invokeLifecycleCallbacks: function(record) {
        record.trigger('didDelete', record);
        record.trigger('didCommit', record);
      }
    }
  },

  // If the adapter indicates that there was an unknown
  // error saving a record, the record enters the `error`
  // state.
  error: {
    isError: true,

    // EVENTS

    invokeLifecycleCallbacks: function(record) {
      record.trigger('becameError', record);
    }
  }
};

var hasOwnProp = {}.hasOwnProperty;

function wireState(object, parent, name) {
  /*jshint proto:true*/
  // TODO: Use Object.create and copy instead
  object = mixin(parent ? Ember.create(parent) : {}, object);
  object.parentState = parent;
  object.stateName = name;

  for (var prop in object) {
    if (!object.hasOwnProperty(prop) || prop === 'parentState' || prop === 'stateName') { continue; }
    if (typeof object[prop] === 'object') {
      object[prop] = wireState(object[prop], object, name + "." + prop);
    }
  }

  return object;
}

RootState = wireState(RootState, null, "root");

DS.RootState = RootState;
