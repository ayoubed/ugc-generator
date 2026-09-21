import streamlit as st
from streamlit_local_storage import LocalStorage

st.write("Testing local storage")
localS = LocalStorage()

api_key = localS.getItem("test_key")
st.write("Value is:", api_key)

if st.button("Set Key"):
    localS.setItem("test_key", "hello_world")
    st.rerun()
