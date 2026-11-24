from cochlea_client import CochleaClient


def test_api_links_are_followed_on_the_clients_own_base_url():
    # e.g. inside docker compose, where the API's public URL isn't reachable
    c = CochleaClient("http://api:8080/v1", api_key="cka_x")
    assert c._url("/sounds") == "http://api:8080/v1/sounds"
    assert (c._url("http://localhost:8080/v1/sounds/96/annotations?low_id=5&page_size=500")
            == "http://api:8080/v1/sounds/96/annotations?low_id=5&page_size=500")
    # anything outside the API is left alone
    assert c._url("http://localhost:4443/storage/v1/b/x") == "http://localhost:4443/storage/v1/b/x"
    assert c._url("https://example.com/v1x") == "https://example.com/v1x"
