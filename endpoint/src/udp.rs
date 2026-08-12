//! The direct path: a bound `wasi:sockets` UDP socket, one datagram per
//! QUIC packet, addressed by real socket addresses.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use crate::bindings::polymorph::iroh::types::Error;
use crate::bindings::wasi::sockets::types::{
    ErrorCode, IpAddressFamily, IpSocketAddress, Ipv4SocketAddress, Ipv6SocketAddress, UdpSocket,
};

/// A bound UDP socket.
pub struct UdpWire {
    socket: UdpSocket,
    local: SocketAddr,
}

/// A socket failure at bind time: `error-code.not-supported` is the
/// host's honest no-UDP answer (the browser profile) and surfaces as
/// `error.not-supported`; anything else rejects the arguments.
fn bind_error(what: &str, code: ErrorCode) -> Error {
    match code {
        ErrorCode::NotSupported => {
            Error::NotSupported("this deployment provides no UDP socket".into())
        }
        other => Error::InvalidArgument(format!("{what}: {other:?}")),
    }
}

impl UdpWire {
    /// Create and bind a socket at `bind_addr` (`ip:port`; port 0 picks a
    /// free one).
    pub fn bind(bind_addr: &str) -> Result<Self, Error> {
        let addr: SocketAddr = bind_addr
            .parse()
            .map_err(|e| Error::InvalidArgument(format!("udp bind address {bind_addr:?}: {e}")))?;
        let family = match addr {
            SocketAddr::V4(_) => IpAddressFamily::Ipv4,
            SocketAddr::V6(_) => IpAddressFamily::Ipv6,
        };
        let socket = UdpSocket::create(family).map_err(|e| bind_error("udp create", e))?;
        socket
            .bind(to_wasi(addr))
            .map_err(|e| bind_error("udp bind", e))?;
        let local = from_wasi(
            socket
                .get_local_address()
                .map_err(|e| bind_error("udp local address", e))?,
        );
        Ok(Self { socket, local })
    }

    /// The bound local address.
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    /// Send one datagram to `remote`.
    pub async fn send(&self, remote: SocketAddr, payload: &[u8]) -> Result<(), String> {
        self.socket
            .send(payload.to_vec(), Some(to_wasi(remote)))
            .await
            .map_err(|e| format!("udp send: {e:?}"))
    }

    /// The next inbound datagram and its source.
    pub async fn receive(&self) -> Result<(Vec<u8>, SocketAddr), ErrorCode> {
        let (payload, remote) = self.socket.receive().await?;
        Ok((payload, from_wasi(remote)))
    }

    /// Send a zero-length datagram to our own address: resolves a pending
    /// `receive` so the pump can retire it without cancelling an in-flight
    /// import (the teardown discipline).
    pub async fn self_wake(&self) -> Result<(), String> {
        self.send(self.local, &[]).await
    }
}

fn to_wasi(addr: SocketAddr) -> IpSocketAddress {
    match addr {
        SocketAddr::V4(v4) => IpSocketAddress::Ipv4(Ipv4SocketAddress {
            port: v4.port(),
            address: {
                let o = v4.ip().octets();
                (o[0], o[1], o[2], o[3])
            },
        }),
        SocketAddr::V6(v6) => IpSocketAddress::Ipv6(Ipv6SocketAddress {
            port: v6.port(),
            flow_info: 0,
            scope_id: 0,
            address: {
                let s = v6.ip().segments();
                (s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7])
            },
        }),
    }
}

fn from_wasi(addr: IpSocketAddress) -> SocketAddr {
    match addr {
        IpSocketAddress::Ipv4(v4) => {
            let (a, b, c, d) = v4.address;
            SocketAddr::new(IpAddr::V4(Ipv4Addr::new(a, b, c, d)), v4.port)
        }
        IpSocketAddress::Ipv6(v6) => {
            let (a, b, c, d, e, f, g, h) = v6.address;
            SocketAddr::new(IpAddr::V6(Ipv6Addr::new(a, b, c, d, e, f, g, h)), v6.port)
        }
    }
}
