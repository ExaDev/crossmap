//! JSON values across the boundary.
//!
//! A value crosses as the JavaScript value itself, walked here, never as text: `null`, a boolean, a finite number, a
//! string of well-formed UTF-16, an array, or a plain object (its prototype `Object.prototype` or `null`) read through
//! its own enumerable string keys in `Object.keys` order. That is exactly the set of values `JSON.parse` returns, so a
//! number means here what `JSON.parse` made of its text, and a key keeps the order JavaScript gives it. Anything else
//! (`undefined`, a function, a symbol, a bigint, `NaN`, an infinity, a lone surrogate, an array hole, a `Date`, a
//! `Map`, a class instance) is refused with a `TypeError` naming where it is, rather than being dropped or converted
//! as `JSON.stringify` would, because the codec promises to read every value it maps.
//!
//! A value goes back the same way: built as plain arrays and objects whose members are set in the value's order.

use std::cell::OnceCell;

use crossmap::Value;
use js_sys::{Array, JsString, Object, Reflect};
use wasm_bindgen::{JsCast as _, JsValue, UnwrapThrowExt as _};

thread_local! {
    static OBJECT_PROTOTYPE: OnceCell<JsValue> = const { OnceCell::new() };
}

/// One step from the root to the value being read, for the message of a refusal.
enum Step {
    Key(String),
    Index(u32),
}

fn location(trail: &[Step]) -> String {
    if trail.is_empty() {
        return "the root".to_owned();
    }
    let mut text = String::new();
    for step in trail {
        match step {
            Step::Key(key) => {
                text.push('[');
                text.push_str(&format!("{key:?}"));
                text.push(']');
            }
            Step::Index(index) => text.push_str(&format!("[{index}]")),
        }
    }
    text
}

fn refuse(name: &str, trail: &[Step], what: &str) -> JsValue {
    js_sys::TypeError::new(&format!(
        "{name} is not a JSON value: {what} at {}",
        location(trail)
    ))
    .into()
}

fn is_plain(object: &Object) -> bool {
    let prototype = Object::get_prototype_of(object);
    prototype.is_null()
        || OBJECT_PROTOTYPE.with(|cell| {
            let plain = cell.get_or_init(|| Object::get_prototype_of(&Object::new()).into());
            Object::is(&prototype, plain)
        })
}

/// Reads a JavaScript value as a JSON value. `name` is what the value is to the caller (`the document`, `sample 2`),
/// which a refusal names.
///
/// # Errors
///
/// A `TypeError` for anything that is not a value `JSON.parse` could have returned.
pub fn from_js(value: &JsValue, name: &str) -> Result<Value, JsValue> {
    let mut trail = Vec::new();
    read(value, name, &mut trail)
}

fn read(value: &JsValue, name: &str, trail: &mut Vec<Step>) -> Result<Value, JsValue> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    if let Some(flag) = value.as_bool() {
        return Ok(Value::Bool(flag));
    }
    if let Some(number) = value.as_f64() {
        return if number.is_finite() {
            Ok(Value::Number(number))
        } else {
            Err(refuse(name, trail, "a number that is not finite"))
        };
    }
    if let Some(text) = value.dyn_ref::<JsString>() {
        if !text.is_valid_utf16() {
            return Err(refuse(name, trail, "a string with a lone surrogate"));
        }
        return Ok(Value::String(String::from(text)));
    }
    if Array::is_array(value) {
        let array: &Array = value.unchecked_ref();
        let mut items = Vec::with_capacity(array.length() as usize);
        for index in 0..array.length() {
            if !Object::has_own(array, &JsValue::from(index)) {
                return Err(refuse(name, trail, &format!("a hole at index {index}")));
            }
            trail.push(Step::Index(index));
            let item = read(&array.get(index), name, trail)?;
            trail.pop();
            items.push(item);
        }
        return Ok(Value::Array(items));
    }
    if value.is_undefined() {
        return Err(refuse(name, trail, "undefined"));
    }
    if value.is_function() {
        return Err(refuse(name, trail, "a function"));
    }
    if value.is_symbol() {
        return Err(refuse(name, trail, "a symbol"));
    }
    if value.is_bigint() {
        return Err(refuse(name, trail, "a bigint"));
    }
    // Every other value of type "object" is an object, a null-prototype record among them, which `dyn_ref::<Object>` would refuse because it tests `instanceof Object`.
    if !value.is_object() {
        return Err(refuse(name, trail, "a value of no JSON type"));
    }
    let object: &Object = value.unchecked_ref();
    if !is_plain(object) {
        return Err(refuse(
            name,
            trail,
            "an object that is not a plain object or array",
        ));
    }
    let keys = Object::keys(object);
    let mut pairs = Vec::with_capacity(keys.length() as usize);
    for key in keys.iter() {
        let member = Reflect::get(object, &key)?;
        // `Object.keys` returns strings only.
        let text: JsString = key.unchecked_into();
        if !text.is_valid_utf16() {
            return Err(refuse(name, trail, "a key with a lone surrogate"));
        }
        let key = String::from(text);
        trail.push(Step::Key(key.clone()));
        let member = read(&member, name, trail)?;
        trail.pop();
        pairs.push((key, member));
    }
    Ok(Value::Object(pairs))
}

/// Builds the JavaScript value of a JSON value. A member named `__proto__` is defined as an own property, as
/// `JSON.parse` makes it, never assigned, which would replace the object's prototype.
pub fn to_js(value: &Value) -> JsValue {
    match value {
        Value::Null => JsValue::NULL,
        Value::Bool(flag) => JsValue::from_bool(*flag),
        Value::Number(number) => JsValue::from_f64(*number),
        Value::String(text) => JsValue::from_str(text),
        Value::Array(items) => {
            let array = Array::new();
            for item in items {
                array.push(&to_js(item));
            }
            array.into()
        }
        Value::Object(pairs) => {
            let object = Object::new();
            for (name, member) in pairs {
                let member = to_js(member);
                let key = JsValue::from_str(name);
                if name == "__proto__" {
                    let descriptor = Object::new();
                    for (field, setting) in [
                        ("value", member),
                        ("writable", JsValue::TRUE),
                        ("enumerable", JsValue::TRUE),
                        ("configurable", JsValue::TRUE),
                    ] {
                        Reflect::set(&descriptor, &JsValue::from_str(field), &setting)
                            .unwrap_throw();
                    }
                    Object::define_property(&object, &key, &descriptor);
                } else {
                    Reflect::set(&object, &key, &member).unwrap_throw();
                }
            }
            object.into()
        }
    }
}
