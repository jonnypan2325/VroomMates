"""Mutable request-local driver and passenger models."""

from .optimizer import order_stops

Coordinate = tuple[float, float]  # (longitude, latitude)


class Driver:
    def __init__(self,x,y,capacity, driver_num):
        self.x = x
        self.y = y
        self.capacity = capacity
        self.driver_num = driver_num
        self.passengers = []

    def get_coords(self):
        return (self.x,self.y)

    def get_capacity(self):
        return self.capacity

    def get_driver_num(self):
        return self.driver_num

    def add_passenger(self, passenger):
        self.passengers.append(passenger)
        self.capacity = self.capacity - 1

    def get_passengers(self):
        return self.passengers

    def get_path(self, destination):
        return order_stops(self, destination)


class Passenger:
    def __init__(self,x,y, passenger_num):
        self.x = x
        self.y = y
        self.passenger_num = passenger_num

    def get_coords(self):
        return (self.x,self.y)

    def get_passenger_num(self):
        return self.passenger_num
